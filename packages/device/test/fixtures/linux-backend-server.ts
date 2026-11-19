// Test-only RPC server (bundled, run with Node) hosting one device operation backend and answering
// JSON lines on stdin. Mode "host": inside a Linux container, exactly as a Linux host runs it
// (agents spawned directly, staged in the private state directory). Mode "docker": on the test's
// own machine, as a local-Docker device runs it (agents through `docker exec` into a container the
// server stages). Only the runtime-hash gate is replaced (no installed package to verify in a
// bundle): it still refuses any hash but the attested one.
import { createInterface } from "node:readline";
import {
  type SandboxExecOptions,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import { createDockerOperationBackend } from "../../src/exec/docker-operations.js";
import {
  createHostOperationBackend,
  type LocalOperationBackend,
} from "../../src/exec/linux-operation-backend.js";
import type { DeviceOwnerCeiling, LocalExecAuthority } from "../../src/exec/operation-types.js";

let backend: LocalOperationBackend | undefined;
let deviceId = "";
const aborts = new Map<string, AbortController>();

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const encode = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
};

async function handle(message: Record<string, unknown>): Promise<unknown> {
  const handleOf = {
    get id() {
      return deviceId;
    },
  };
  const controller = new AbortController();
  aborts.set(String(message.id), controller);
  const signal = controller.signal;
  switch (message.op) {
    case "create": {
      deviceId = String(message.deviceId);
      const ceiling = message.ceiling as DeviceOwnerCeiling;
      const expected = String(message.runtimeHash);
      backend?.lifecycle.dispose();
      const common = {
        deviceId,
        instanceGeneration: String(message.generation),
        stateDir: String(message.stateDir),
        pythonPath: "/usr/bin/python3",
        runtimeHash: expected,
      };
      const linux = {
        acquireRuntime: async (hash: string | undefined) => {
          if (hash !== expected)
            throw new SandboxPermissionUnsupportedError("Not the attested runtime");
          return { release: () => {} };
        },
        ...(message.restrictedSupported === false ? { restrictedSupported: false } : {}),
        // the fixture's endpoints are local addresses
        allowPrivateProxyTargets: message.privateProxyTargets !== false,
        ...(message.faultInjection
          ? { faultInjection: message.faultInjection as { stagedMove: "fail" } }
          : {}),
        ...(message.dohTest
          ? { fakeIpDnsTest: message.dohTest as { endpoints: string[]; caPem: string } }
          : {}),
      };
      if (message.mode === "docker") {
        const container = String(message.container);
        backend = await createDockerOperationBackend(
          {
            ...common,
            hostRoots: message.hostRoots as { workspace: string; skills: string; tmp: string },
            readOwnerCeiling: async () => ceiling,
            container: {
              operationContainer: async () => ({
                name: container,
                user: String(message.user),
                release: () => {},
              }),
            },
          },
          linux,
        );
      } else
        backend = await createHostOperationBackend(
          { ...common, roots: ceiling.roots, readOwnerCeiling: async () => ceiling },
          { platform: "linux", linux },
        );
      return backend.permissionSupport({ id: deviceId }, signal);
    }
    case "support":
      return backend?.permissionSupport(handleOf, signal);
    case "operation": {
      if (!backend) throw new Error("No backend");
      const authority = message.authority as LocalExecAuthority | undefined;
      const factory = authority ? backend.forExecution(authority) : backend;
      const operation = await factory.operation(
        handleOf,
        message.scope as Parameters<LocalOperationBackend["operation"]>[1],
        signal,
      );
      const args = message.args as Record<string, unknown>;
      switch (message.method) {
        case "exec":
          return operation.exec({
            ...(args as unknown as Omit<SandboxExecOptions, "signal">),
            signal,
          });
        case "readFile":
          return operation.readFile(String(args.path), { maxBytes: Number(args.maxBytes), signal });
        case "writeFile":
          return operation.writeFile(
            String(args.path),
            new Uint8Array(Buffer.from(String(args.dataB64), "base64")),
            signal,
          );
        case "stat":
          return operation.stat(String(args.path), signal);
        case "list":
          return operation.list?.(String(args.path), { limit: Number(args.limit), signal });
        case "scan":
          return operation.scan?.(String(args.path), { signal });
      }
      throw new Error("Unknown operation method");
    }
    case "background": {
      if (!backend) throw new Error("No backend");
      const authority = message.authority as LocalExecAuthority | undefined;
      const bg = authority ? backend.forExecution(authority).background : backend.background;
      const args = (message.args ?? {}) as Record<string, unknown>;
      const ref = message.ref as Parameters<typeof bg.status>[1];
      switch (message.method) {
        case "start":
          return bg.start(handleOf, message.scope as never, {
            ...(args as unknown as Omit<Parameters<typeof bg.start>[2], "signal">),
            signal,
          });
        case "status":
          return bg.status(handleOf, ref, signal);
        case "tail":
          return bg.tail(handleOf, ref, { maxBytes: Number(args.maxBytes), signal });
        case "readOutput":
          return bg.readOutput(handleOf, ref, {
            offset: Number(args.offset),
            maxBytes: Number(args.maxBytes),
            signal,
          });
        case "stop":
          return bg.stop(handleOf, ref, { graceMs: Number(args.graceMs ?? 0), signal });
      }
      throw new Error("Unknown background method");
    }
    case "revoke":
      return backend?.revokeOperation(handleOf, message.ref as never, signal);
    case "abort":
      aborts.get(String(message.target))?.abort(new Error("aborted by the test"));
      return true;
  }
  throw new Error("Unknown op");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  void handle(message)
    .then((result) => send({ id: message.id, result: encode(result ?? null) }))
    .catch((error: Error & Record<string, unknown>) =>
      send({
        id: message.id,
        error: {
          name: error?.name,
          message: error?.message,
          denied: error?.sandboxScopeDenied === true,
          unsupported: error?.sandboxPermissionUnsupported === true,
          unknown: error?.sandboxOperationOutcomeUnknown === true,
        },
      }),
    )
    .finally(() => aborts.delete(String(message.id)));
});
send({ ready: true, pid: process.pid });
