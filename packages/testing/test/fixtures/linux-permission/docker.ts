import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  type ExecResult,
  SANDBOX_RUNTIME_SOURCE,
  type SandboxOperation,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import type { NativeFixtureEntry } from "../../../src/sandbox-native-conformance.js";
import type {
  SandboxPermissionEndpoint,
  SandboxPermissionFixture,
  SandboxPermissionGrant,
} from "../../../src/sandbox-permission-conformance.js";

/**
 * Test-only Docker transport for the SDK's Linux runtime: one device container with the provider's
 * unchanged hardening (read-only rootfs, cap-drop ALL, no-new-privileges, Docker's default
 * seccomp, a non-root UID, no network). It stands in for a provider: the agent pins roots and
 * launches the staged runtime; it is not the Docker provider and not proof for it.
 */
export const IMAGE =
  process.env.CAPYBARA_TEST_SANDBOX_IMAGE ?? "ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.15";
export const RUNTIME_DIR = "/opt/capybara-runtime";
const RECEIPTS_DIR = "/opt/capybara-receipts";
const FIXTURES = new URL("./", import.meta.url);

/** Why the Docker evidence cannot run here, or null when it can. */
export function dockerUnavailable(): string | null {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    return "Docker is not available";
  }
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status !== 0) {
    const pulled = spawnSync("docker", ["pull", IMAGE], { stdio: "ignore" });
    if (pulled.status !== 0) return `The sandbox image ${IMAGE} is not available`;
  }
  return null;
}

function docker(args: string[], input?: string | Uint8Array): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Stages a deliberately broken copy of the launcher (evidence that a test detects the defect) in
 * its own root-owned directory with the agent and native helper, and returns that directory.
 */
export function stageMutant(
  device: DeviceContainer,
  name: string,
  from: string,
  to: string,
): string {
  const linux = SANDBOX_RUNTIME_SOURCE.files.find((file) => file.name === "linux-sandbox.py");
  if (!linux?.source.includes(from)) throw new Error(`mutation ${name} no longer applies`);
  const directory = `${RUNTIME_DIR}/mutant-${name}`;
  device.run(
    `mkdir -p ${directory} && cp ${RUNTIME_DIR}/agent.py ${RUNTIME_DIR}/native-files.py ${directory}/`,
    "0",
  );
  docker(
    ["exec", "-i", "-u", "0", device.name, "sh", "-c", `cat > ${directory}/linux-sandbox.py`],
    linux.source.replace(from, to),
  );
  device.run(`chmod 644 ${directory}/*`, "0");
  return directory;
}

export const HARDENING = [
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--network",
  "none",
] as const;

export interface DeviceContainer {
  readonly name: string;
  /** Runs a command as the device user (or root for staging) and returns stdout. */
  run(command: string, user?: string): string;
  remove(): void;
}

/** Starts one hardened device container and stages hash-verified runtime bytes, root-owned. */
export function startDevice(): DeviceContainer {
  const name = `capybara-perm-${randomUUID().slice(0, 12)}`;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "capybara.test=permission-conformance",
    ...HARDENING,
    "--tmpfs",
    "/tmp:size=64m",
    "--tmpfs",
    "/home/sandbox:uid=1000,gid=1000,mode=755",
    "--tmpfs",
    "/workspace:exec,uid=1000,gid=1000,mode=755",
    "--tmpfs",
    `${RUNTIME_DIR}:mode=755`,
    "--tmpfs",
    `${RECEIPTS_DIR}:mode=755`,
    IMAGE,
    "sleep",
    "infinity",
  ]);
  const run = (command: string, user = "1000:1000") =>
    docker(["exec", "-i", "-u", user, name, "sh", "-c", command]);
  const stage = (file: string, source: string, sha256?: string) => {
    docker(["exec", "-i", "-u", "0", name, "sh", "-c", `cat > ${RUNTIME_DIR}/${file}`], source);
    if (sha256) {
      // Consumer staging verifies the shipped digest inside the device before any use.
      const inside = run(`sha256sum ${RUNTIME_DIR}/${file}`).split(" ")[0];
      if (inside !== sha256) throw new Error(`${file} digest mismatch after staging`);
    }
  };
  try {
    for (const file of SANDBOX_RUNTIME_SOURCE.files) {
      if (createHash("sha256").update(file.source).digest("hex") !== file.sha256) {
        throw new Error(`${file.name} does not match its bundle digest`);
      }
      stage(file.name, file.source, file.sha256);
    }
    for (const file of ["agent.py", "listen.py", "outer-deny.py", "flip.c"]) {
      stage(file, readFileSync(new URL(file, FIXTURES), "utf8"));
    }
    run(`chmod 644 ${RUNTIME_DIR}/*`, "0");
  } catch (error) {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    throw error;
  }
  return {
    name,
    run,
    remove: () => {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
  };
}

const ENDPOINTS = {
  granted: ["127.0.0.1", 18080],
  ungranted4: ["127.0.0.1", 18081],
  ungranted6: ["::1", 18082],
} as const;

/** Starts the controlled endpoints as root so the device user cannot forge receipts. */
export function startEndpoints(device: DeviceContainer): void {
  const child = spawn("docker", [
    "exec",
    "-u",
    "0",
    device.name,
    "python3",
    "-I",
    `${RUNTIME_DIR}/listen.py`,
    RECEIPTS_DIR,
    JSON.stringify(ENDPOINTS),
  ]);
  child.unref();
  const ready = spawnSync("docker", ["exec", device.name, "python3", "-c", WAIT_READY], {
    encoding: "utf8",
  });
  if (ready.status !== 0) throw new Error(`endpoints did not start: ${ready.stderr}`);
}

const WAIT_READY = `
import socket
for port, host in ((18080, "127.0.0.1"), (18081, "127.0.0.1"), (18082, "::1")):
    while True:
        try:
            socket.create_connection((host, port)).close()
            break
        except OSError:
            pass
`;

interface AgentResponse {
  id?: string;
  result?: unknown;
  error?: string;
  code?: number;
  events?: { event: string; code?: string; [key: string]: unknown }[];
  extra?: { pinned: { path: string; fd: number; dev: number; ino: number }[] } | null;
  stdout?: string;
  stderr?: string;
  native?: { result?: unknown; error?: { code: string; message: string } } | null;
}

/** The trusted in-device consumer (pins roots, launches the runtime), over one docker exec. */
export class Agent {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (response: AgentResponse) => void>();
  readonly ready: Promise<void>;

  constructor(
    device: DeviceContainer,
    options: { outer?: "landlock" | "listener"; runtime?: string; candidateArch?: boolean } = {},
  ) {
    const program = ["/usr/bin/python3", "-I", `${options.runtime ?? RUNTIME_DIR}/agent.py`];
    const command = options.outer
      ? ["/usr/bin/python3", "-I", `${RUNTIME_DIR}/outer-deny.py`, options.outer, ...program]
      : program;
    const endpoints = Object.fromEntries(
      [ENDPOINTS.granted].map(([address, port]) => [address, { address, port }]),
    );
    this.child = spawn("docker", [
      "exec",
      "-i",
      "-u",
      "1000:1000",
      device.name,
      ...command,
      JSON.stringify(endpoints),
      JSON.stringify({ candidateArch: options.candidateArch === true }),
    ]);
    let markReady: () => void = () => {};
    this.ready = new Promise((resolve) => {
      markReady = resolve;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as AgentResponse & { ready?: boolean };
      if (message.ready) return markReady();
      const resolve = message.id ? this.pending.get(message.id) : undefined;
      if (message.id) this.pending.delete(message.id);
      resolve?.(message);
    });
  }

  request(body: Record<string, unknown>): Promise<AgentResponse> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, (response) =>
        response.error ? reject(new Error(response.error)) : resolve(response),
      );
      this.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    }).then((response) => ({ ...(response as AgentResponse), id }));
  }

  /** Sends a request whose ID the caller needs before it finishes (for cancellation). */
  start(body: Record<string, unknown>): { id: string; done: Promise<AgentResponse> } {
    const id = randomUUID();
    const done = new Promise<AgentResponse>((resolve, reject) => {
      this.pending.set(id, (response) =>
        response.error ? reject(new Error(response.error)) : resolve(response),
      );
    });
    this.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    return { id, done };
  }

  /** Waits until a trusted inspection sees the file (a readiness barrier, no fixed sleep). */
  async waitFor(path: string): Promise<void> {
    while ((await this.request({ op: "inspect", what: "read", path })).result === null) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const decode = (value?: string) => Buffer.from(value ?? "", "base64").toString();

function refusal(response: AgentResponse): Error | null {
  const refused = response.events?.find((event) => event.event === "refused");
  if (!refused) return null;
  if (refused.code === "UNAVAILABLE") {
    return new SandboxPermissionUnsupportedError("Restricted Linux execution is unavailable");
  }
  if (refused.code === "SCOPE_DENIED" || refused.code === "ROOT_CHANGED") {
    return new SandboxScopeDeniedError("The pinned root no longer names the granted object");
  }
  return new Error(`Restricted launch refused: ${refused.code}`);
}

export function execResult(response: AgentResponse, restricted: boolean): ExecResult {
  const error = refusal(response);
  if (error) throw error;
  const exit = response.events?.find((event) => event.event === "exit") as
    | { exitCode: number | null; timedOut: boolean; cancelled: boolean }
    | undefined;
  const stopped = restricted ? !exit || exit.exitCode === null : (response.code ?? 0) < 0;
  return {
    exitCode: stopped ? null : restricted ? (exit?.exitCode ?? null) : (response.code ?? null),
    stdout: decode(response.stdout),
    stderr: decode(response.stderr),
    truncated: false,
    timedOut: restricted ? Boolean(exit?.timedOut) : false,
  };
}

/** One-shot operations over the agent for an immutable copy of the grant. */
export function operation(agent: Agent, grant: SandboxPermissionGrant): SandboxOperation {
  const frozen = structuredClone(grant);
  Object.freeze(frozen);
  const restricted = frozen.filesystem.kind === "scoped";
  let consumed = false;
  const consume = () => {
    if (consumed) throw new Error("An operation ID is consumed once");
    consumed = true;
  };
  const native = async (body: Record<string, unknown>, signal: AbortSignal) => {
    signal.throwIfAborted();
    consume();
    const response = await agent.request({
      op: "native",
      mode: "native",
      grant: frozen,
      native: body,
    });
    const error = refusal(response);
    if (error) throw error;
    const reply = response.native;
    if (!reply) throw new Error(`native helper gave no reply: ${decode(response.stderr)}`);
    if (reply.error) {
      if (reply.error.code === "SCOPE_DENIED" || reply.error.code === "EACCES") {
        throw new SandboxScopeDeniedError("The native path is outside the operation scope");
      }
      throw new Error(`${reply.error.code}: ${reply.error.message}`);
    }
    return reply.result;
  };
  return {
    async exec(args) {
      args.signal.throwIfAborted();
      consume();
      const started = agent.start({
        op: "exec",
        mode: "exec",
        grant: frozen,
        command: args.command,
        cwd: args.cwd,
        env: args.env ?? {},
        timeoutMs: args.timeoutMs,
        maxOutputBytes: args.maxOutputBytes,
      });
      const cancel = () => void agent.request({ op: "cancel", target: started.id });
      args.signal.addEventListener("abort", cancel, { once: true });
      try {
        return execResult(await started.done, restricted);
      } finally {
        args.signal.removeEventListener("abort", cancel);
      }
    },
    async readFile(path, { maxBytes, signal }) {
      const value = (await native({ method: "readFile", path, maxBytes }, signal)) as {
        dataB64: string;
        truncated: boolean;
      } | null;
      return (
        value && {
          data: new Uint8Array(Buffer.from(value.dataB64, "base64")),
          truncated: value.truncated,
        }
      );
    },
    async writeFile(path, data, signal) {
      await native(
        { method: "writeFile", path, dataB64: Buffer.from(data).toString("base64") },
        signal,
      );
    },
    async stat(path, signal) {
      return (await native({ method: "stat", path }, signal)) as {
        size: number;
        isDir: boolean;
      } | null;
    },
    async list(path, { limit, signal }) {
      return (await native({ method: "list", path, limit }, signal)) as {
        entries: { name: string; isDir: boolean }[];
        truncated: boolean;
      } | null;
    },
    async scan(base, { signal }) {
      return (await native({ method: "scan", path: base }, signal)) as {
        path: string;
        suggestedName: string;
      }[];
    },
  };
}

/** A runtime report mapped from the launcher's own probe; never a fixture flag. */
export async function support(agent: Agent): Promise<SandboxPermissionSupport> {
  const probe = (await agent.request({ op: "probe" })).result as {
    restricted: { filesystem: true; network: true; native: true; concurrentScopes: true } | null;
    reason?: string;
  };
  return {
    version: 1,
    restricted: probe.restricted,
    fullAccess: true,
    background: false,
    ...(probe.reason ? { unavailableReason: probe.reason } : {}),
  };
}

function endpoint(device: Agent, name: keyof typeof ENDPOINTS): SandboxPermissionEndpoint {
  const [host, port] = ENDPOINTS[name];
  return {
    host,
    port,
    async receipts() {
      const value = (
        await device.request({ op: "inspect", what: "read", path: `${RECEIPTS_DIR}/${name}` })
      ).result as string | null;
      return value === null ? 0 : Number(Buffer.from(value, "base64").toString());
    },
  };
}

/** The permission fixture over one hardened container, its agent and controlled endpoints. */
export async function dockerPermissionFixture(
  device: DeviceContainer,
  agent: Agent,
  dispose: () => Promise<void>,
): Promise<SandboxPermissionFixture> {
  const id = randomUUID().slice(0, 8);
  const root = `/workspace/project-${id}`;
  const sibling = `/workspace/sibling-${id}`;
  device.run(`mkdir ${root} ${sibling} && printf rc > /home/sandbox/.profile-${id}`);
  const read = async (path: string) => {
    const value = (await agent.request({ op: "inspect", what: "read", path })).result as
      | string
      | null;
    return value === null ? null : new Uint8Array(Buffer.from(value, "base64"));
  };
  return {
    root,
    sibling,
    protectedPaths: [`/home/sandbox/.profile-${id}`],
    endpoints: {
      granted: endpoint(agent, "granted"),
      ungranted: [endpoint(agent, "ungranted4"), endpoint(agent, "ungranted6")],
    },
    support: () => support(agent),
    operation: async (grant) => operation(agent, grant),
    async seed(entries: readonly NativeFixtureEntry[]) {
      await agent.request({
        op: "seed",
        entries: entries.map((entry) =>
          entry.kind === "file"
            ? { ...entry, data: undefined, dataB64: Buffer.from(entry.data).toString("base64") }
            : entry,
        ),
      });
    },
    inspect: {
      readFile: read,
      mode: async (path) =>
        (await agent.request({ op: "inspect", what: "mode", path })).result as number | null,
      alive: async (pids) =>
        (await agent.request({ op: "inspect", what: "alive", pids })).result as number[],
    },
    dispose,
  };
}
