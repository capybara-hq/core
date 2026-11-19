import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type ExecResult,
  type SandboxExecutionRef,
  type SandboxOperation,
  SandboxOperationOutcomeUnknownError,
  type SandboxOperationScope,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { build } from "esbuild";
import type { DeviceOwnerCeiling, LocalExecAuthority } from "../src/exec/operation-types.js";
import { fixtureCeiling, type LinuxDevice, NAMES } from "./linux-docker-fixture.js";

const SERVER_DIR = "/home/sandbox/capybara-test";

let bundled: string | undefined;
/** The test server bundled once per run (the backend, the SDK and their dependencies). */
async function bundle(): Promise<string> {
  if (bundled) return bundled;
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/linux-backend-server.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["@capybara-hq/source"],
    write: false,
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  bundled = result.outputFiles[0]?.text ?? "";
  return bundled;
}

/** Copies the bundled server into the device (owned by the device user, as a host install is). */
export async function installServer(device: LinuxDevice): Promise<void> {
  const source = await bundle();
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "1000:1000",
      device.name,
      "sh",
      "-c",
      `mkdir -p ${SERVER_DIR} && cat > ${SERVER_DIR}/server.mjs`,
    ],
    { input: source },
  );
  if (result.status !== 0) throw new Error(`installing the server failed: ${result.stderr}`);
}

/** Writes the bundled server to a file on this machine (for a local-Docker device server). */
export async function localServerFile(dir: string): Promise<{ local: string }> {
  const local = join(dir, "server.mjs");
  await writeFile(local, await bundle());
  return { local };
}

type Reply = { id?: string; result?: unknown; error?: Record<string, unknown>; ready?: boolean };

const decode = (value: unknown): unknown => {
  if (value && typeof value === "object" && "$bytes" in value)
    return new Uint8Array(Buffer.from(String((value as { $bytes: string }).$bytes), "base64"));
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  return value;
};

/**
 * One device process (the bundled server): inside the container for a Linux host, or on this
 * machine (`"local"`) for a local-Docker device whose agents run in the container.
 */
export class HostServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (reply: Reply) => void>();
  readonly ready: Promise<number>;
  readonly exited: Promise<void>;

  constructor(where: LinuxDevice | { local: string }) {
    this.child =
      "local" in where
        ? spawn(process.execPath, [where.local])
        : spawn("docker", [
            "exec",
            "-i",
            "-u",
            "1000:1000",
            where.name,
            "node",
            `${SERVER_DIR}/server.mjs`,
          ]);
    let markReady: (pid: number) => void = () => {};
    this.ready = new Promise((resolve) => {
      markReady = resolve;
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stderr.on("data", (b: Buffer) => process.stderr.write(b));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const reply = JSON.parse(line) as Reply & { pid?: number };
      if (reply.ready) return markReady(Number(reply.pid));
      const resolve = reply.id ? this.pending.get(reply.id) : undefined;
      if (reply.id) this.pending.delete(reply.id);
      resolve?.(reply);
    });
  }

  /** Sends a request; `onId` learns its ID first (to abort it). */
  call(body: Record<string, unknown>, onId?: (id: string) => void): Promise<unknown> {
    const id = randomUUID();
    onId?.(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) => {
        if (!reply.error) return resolve(decode(reply.result));
        const message = String(reply.error.message);
        reject(
          reply.error.denied
            ? new SandboxScopeDeniedError(message)
            : reply.error.unsupported
              ? new SandboxPermissionUnsupportedError(message)
              : reply.error.unknown
                ? new SandboxOperationOutcomeUnknownError(message)
                : new Error(message),
        );
      });
      this.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

export interface HostBackend {
  server: HostServer;
  deviceId: string;
  ceiling: DeviceOwnerCeiling;
  support(): Promise<SandboxPermissionSupport>;
  operation(scope: SandboxOperationScope, authority?: LocalExecAuthority): SandboxOperation;
  background(
    method: "start" | "status" | "tail" | "readOutput" | "stop",
    body: {
      scope?: SandboxOperationScope;
      ref?: SandboxExecutionRef;
      args?: object;
      authority?: LocalExecAuthority;
    },
  ): Promise<unknown>;
}

export const RUNTIME_HASH = "a".repeat(64);

/** Creates the Linux backend in a server process over a state directory in the container. */
export async function hostBackend(
  server: HostServer,
  options: {
    stateDir: string;
    deviceId?: string;
    restrictedSupported?: boolean;
    deniedReadRoots?: string[];
    /** Whether the allowlist proxy may reach the fixture's local endpoints (default true). */
    privateProxyTargets?: boolean;
    /** The owner's sandbox network (default the fixture's allowlist) and allowed domains. */
    network?: "open" | "allowlist";
    allowedDomains?: string[];
    /** The owner's restricted project reach (default the workspace). */
    restrictedProjectReach?: "workspace" | "os-user";
    /** A local-Docker device: the server runs here, its agents in this container. */
    docker?: { container: string; hostRoots: { workspace: string; skills: string; tmp: string } };
  },
): Promise<HostBackend> {
  await server.ready;
  const deviceId = options.deviceId ?? "device-linux";
  const ceiling = {
    ...fixtureCeiling({ workspace: "/workspace", skills: "/home/sandbox/skills", tmp: "/tmp" }),
    restrictedDeniedReadRoots: options.deniedReadRoots ?? [],
    ...(options.network ? { network: options.network } : {}),
    ...(options.allowedDomains ? { allowedDomains: options.allowedDomains } : {}),
    ...(options.restrictedProjectReach
      ? { restrictedProjectReach: options.restrictedProjectReach }
      : {}),
  };
  await server.call({
    op: "create",
    deviceId,
    generation: "generation",
    stateDir: options.stateDir,
    ceiling,
    runtimeHash: RUNTIME_HASH,
    ...(options.restrictedSupported === false ? { restrictedSupported: false } : {}),
    ...(options.privateProxyTargets === false ? { privateProxyTargets: false } : {}),
    ...(options.docker
      ? {
          mode: "docker",
          container: options.docker.container,
          user: "1000:1000",
          hostRoots: options.docker.hostRoots,
        }
      : { mode: "host" }),
  });
  const run = (
    scope: SandboxOperationScope,
    authority: LocalExecAuthority | undefined,
    method: string,
    args: object,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    let id = "";
    const pending = server.call(
      { op: "operation", scope, ...(authority ? { authority } : {}), method, args },
      (value) => {
        id = value;
      },
    );
    const abort = () => void server.call({ op: "abort", target: id });
    signal.addEventListener("abort", abort, { once: true });
    return pending.finally(() => signal.removeEventListener("abort", abort));
  };
  return {
    server,
    deviceId,
    ceiling,
    support: async () => (await server.call({ op: "support" })) as SandboxPermissionSupport,
    operation: (scope, authority) => ({
      exec: async ({ signal, ...args }) =>
        (await run(scope, authority, "exec", args, signal)) as ExecResult,
      readFile: async (path, { maxBytes, signal }) =>
        (await run(scope, authority, "readFile", { path, maxBytes }, signal)) as {
          data: Uint8Array;
          truncated: boolean;
        } | null,
      writeFile: async (path, data, signal) => {
        await run(
          scope,
          authority,
          "writeFile",
          { path, dataB64: Buffer.from(data).toString("base64") },
          signal,
        );
      },
      stat: async (path, signal) =>
        (await run(scope, authority, "stat", { path }, signal)) as {
          size: number;
          isDir: boolean;
        } | null,
      list: async (path, { limit, signal }) =>
        (await run(scope, authority, "list", { path, limit }, signal)) as {
          entries: { name: string; isDir: boolean }[];
          truncated: boolean;
        } | null,
      scan: async (path, { signal }) =>
        (await run(scope, authority, "scan", { path }, signal)) as {
          path: string;
          suggestedName: string;
        }[],
    }),
    background: (method, body) => server.call({ op: "background", method, ...body }),
  };
}

/** The execution authority the kernel would send for an operation (org allowlist: granted). */
export const authorityFor = (operationId: string): LocalExecAuthority => ({
  operationId,
  orgNetwork: { kind: "allowlist", hosts: [NAMES.granted] },
});

/** The execution authority of an org whose sandbox network is the open public internet. */
export const openAuthorityFor = (operationId: string): LocalExecAuthority => ({
  operationId,
  orgNetwork: { kind: "open-public", hosts: [] },
});
