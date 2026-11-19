import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The device's own backend and test helpers (the device package may not depend on this one, so
// its macOS backend meets the harness here, as its Linux backends do in device-linux-backend).
import {
  createMacOperationBackend,
  type MacOperationBackend,
} from "../../device/src/exec/mac-operation-backend.js";
import type { DeviceOwnerCeiling } from "../../device/src/exec/operation-types.js";
import { startMacOperationWorker } from "../../device/src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "../../device/test/runtime-seal.js";
import type { NativeFixtureEntry } from "../src/sandbox-native-conformance.js";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
  type SandboxPermissionGrant,
} from "../src/sandbox-permission-conformance.js";

/**
 * The capybara-device macOS operation backend (immutable SRT workers, the native descriptor
 * helper, the per-operation proxy) against the same permission conformance the Linux backends,
 * the Docker provider and the E2B template pass: real Seatbelt, real processes, real sockets.
 *
 * Everything lives under one temporary directory: the device's roots and state, the granted
 * project, a sibling project, and a temporary home with an SSH key and a shell profile (the
 * protected files no restricted grant covers). The real home is never read or written: HOME
 * points at the temporary one while this file runs.
 *
 * Endpoints are loopback HTTP servers (IPv4 and IPv6). No name can lead to them without a
 * hosts-file change, and the operation's proxy refuses an allowlisted name that resolves to
 * loopback (its DNS-rebinding guard), so the harness runs every network negative here and the
 * by-name positive is skipped (`namedReach: "unavailable"`).
 *
 * Not covered here, by design: the harness's `outside` probe (it reads Linux `/proc`); on macOS a
 * same-user process outside every operation may signal or trace the device's processes (a known
 * limitation of Full access sharing the device's OS user, recorded in the evidence report).
 */

const darwin = process.platform === "darwin";
const NAMES = {
  granted: "granted.permission.test",
  ungranted4: "ungranted4.permission.test",
  ungranted6: "ungranted6.permission.test",
} as const;
const DEVICE_ID = "device-mac";

let dir = "";
let priorHome: string | undefined;
let priorPath: string | undefined;
const servers: Server[] = [];
const seal = { runtimeHash: "", cleanup: async () => {} };

/** A loopback HTTP endpoint that counts the connections it accepts. */
async function endpoint(
  name: string,
  address: "127.0.0.1" | "::1",
): Promise<SandboxPermissionEndpoint> {
  let accepted = 0;
  const server = createServer((_req, res) => res.end("ok"));
  server.on("connection", () => {
    accepted++;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  return {
    name,
    address,
    port: (server.address() as AddressInfo).port,
    receipts: async () => accepted,
  };
}

let sequence = 0;
const scopeFor = (grant: SandboxPermissionGrant): SandboxOperationScope => {
  const operationId = `op-${++sequence}`;
  return {
    operationId,
    admitBeforeMs: Date.now() + 120_000,
    deviceId: DEVICE_ID,
    rootConversationId: "conversation",
    profileRevision: 0,
    ceilingRevision: "ceiling",
    profile: grant.profile,
    actor: { accountId: "account", conversationId: "conversation" },
    tag: operationId,
    filesystem: grant.filesystem,
    network: grant.network,
  } as SandboxOperationScope;
};

describe.runIf(darwin)("capybara-device macOS operation backend", () => {
  let backend: MacOperationBackend;
  let ceiling: DeviceOwnerCeiling;
  let root = "";
  let fixture: SandboxPermissionFixture;

  beforeAll(async () => {
    Object.assign(seal, await sealWorkspaceRuntime());
    // a short base: the harness's UNIX sockets live under it (macOS caps their paths at 104 bytes,
    // and the per-user temporary directory alone is about 50)
    dir = await realpath(await mkdtemp("/tmp/cmc-"));
    const home = join(dir, "home");
    const roots = {
      workspace: join(home, ".capybara", "device", "workspace"),
      skills: join(home, ".capybara", "device", "skills"),
      tmp: join(home, ".capybara", "device", "tmp"),
    };
    const stateDir = join(home, ".capybara", "device", "state");
    for (const path of [...Object.values(roots), join(home, ".ssh")])
      await mkdir(path, { recursive: true });
    await mkdir(stateDir, { mode: 0o700 });
    root = join(home, "code", "project");
    const sibling = join(home, "code", "sibling");
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const key = join(home, ".ssh", "id_ed25519");
    const profile = join(home, ".zshrc");
    await writeFile(key, "synthetic-private-key\n", { mode: 0o600 });
    await writeFile(profile, "export SYNTHETIC=1\n");
    priorHome = process.env.HOME;
    priorPath = process.env.PATH;
    process.env.HOME = home;
    // version manager shims resolve their versions from the real home: run the real binaries
    process.env.PATH = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      ":",
    );

    ceiling = {
      revision: "one",
      outsideSandbox: true,
      network: "allowlist",
      roots,
      restrictedProjectReach: "os-user",
      allowedDomains: [NAMES.granted],
      restrictedDeniedReadRoots: [stateDir],
      preparation: { skillsRoot: roots.skills, attachmentsBase: join(roots.workspace, "a") },
    };
    backend = await createMacOperationBackend(
      {
        deviceId: DEVICE_ID,
        instanceGeneration: "generation",
        stateDir,
        roots,
        pythonPath: "/usr/bin/python3",
        runtimeHash: seal.runtimeHash,
        readOwnerCeiling: async () => ceiling,
      },
      {
        platform: "darwin",
        restrictedSupported: true,
        startWorker: startMacOperationWorker,
        watch: () => () => {},
      },
    );
    const granted = await endpoint(NAMES.granted, "127.0.0.1");
    const ungranted = [
      await endpoint(NAMES.ungranted4, "127.0.0.1"),
      await endpoint(NAMES.ungranted6, "::1"),
    ];
    const handle = { id: DEVICE_ID };
    fixture = {
      root,
      sibling,
      protectedPaths: [key, profile],
      // a local device ties the environment network to Full access (owner ceiling policy)
      restrictedEnvironment: "refused",
      // Seatbelt enforces paths as APFS resolves them (device mac-write-denies tests the
      // Unicode case-fold aliases APFS applies); fullwidth spellings are distinct files there
      foldedNames: "filesystem",
      // the worker runs its runtime with local binding off: no listener at all, loopback included
      restrictedLoopbackListen: "refused",
      // macOS also ends a regrouped descendant it still finds by parent pid, but not one already
      // reparented to launchd (contract, "Explicit background supervision"); the aborted call
      // completes either way (device mac-abort-escape.test.ts)
      regroupedDescendants: "not-promised",
      // no hosts-file entry may lead the allowlisted name here, and the operation's proxy
      // refuses a name resolving to loopback: the positive allowlist reach is proved by the
      // device's own "overlapping real immutable workers retain their separate network grants"
      endpoints: { granted, ungranted, access: "proxy", namedReach: "unavailable" },
      support: () => backend.permissionSupport(handle, new AbortController().signal),
      operation: async (grant) => {
        const scope = scopeFor(grant);
        const operation = await backend
          .forExecution({
            operationId: scope.operationId,
            orgNetwork: { kind: "allowlist", hosts: [NAMES.granted] },
          })
          .operation(handle, scope, new AbortController().signal);
        // the device sends read bytes as base64 over its socket; in process they are a Buffer
        const readFile = operation.readFile.bind(operation);
        return {
          ...operation,
          exec: operation.exec.bind(operation),
          writeFile: operation.writeFile.bind(operation),
          stat: operation.stat.bind(operation),
          ...(operation.list && { list: operation.list.bind(operation) }),
          ...(operation.scan && { scan: operation.scan.bind(operation) }),
          readFile: async (path, opts) => {
            const read = await readFile(path, opts);
            return read === null ? null : { ...read, data: new Uint8Array(read.data) };
          },
        };
      },
      seed: async (entries: readonly NativeFixtureEntry[]) => {
        for (const entry of entries) {
          await mkdir(entry.kind === "directory" ? entry.path : dirname(entry.path), {
            recursive: true,
          });
          if (entry.kind === "file") await writeFile(entry.path, entry.data);
          else if (entry.kind === "symlink") await symlink(entry.target, entry.path);
        }
      },
      inspect: {
        readFile: async (path) =>
          readFile(path).then(
            (b) => new Uint8Array(b),
            () => null,
          ),
        mode: async (path) =>
          stat(path).then(
            (s) => s.mode & 0o7777,
            () => null,
          ),
        alive: async (pids) =>
          pids.filter((pid) => spawnSync("/bin/kill", ["-0", String(pid)]).status === 0),
      },
      dispose: async () => {},
    };
  });

  afterAll(async () => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorPath !== undefined) process.env.PATH = priorPath;
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await seal.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports restricted support from the real runtime, with Full access and background work", async () => {
    const support = await fixture.support();
    expect(support).toMatchObject({
      restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
      boundary: "operation",
      network: { openPublic: true, allowlist: true, perOperationHosts: true },
      outsideSandbox: true,
      background: true,
    });
  });

  it("passes the full permission conformance", async () => {
    await runSandboxPermissionConformance(fixture);
  });

  it("starts, polls and stops a background test run by its exact ref while a sibling runs on", async () => {
    const signal = new AbortController().signal;
    const handle = { id: DEVICE_ID };
    const grant: SandboxPermissionGrant = {
      profile: "request-approval",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network: { kind: "none" },
    };
    const start = async (taskId: string) => {
      const scope = scopeFor(grant);
      const ref = await backend
        .forExecution({
          operationId: scope.operationId,
          orgNetwork: { kind: "allowlist", hosts: [] },
        })
        .background.start(handle, scope, {
          // a test runner's shape: progress lines until it is stopped
          command: `i=0; while true; do echo "${taskId} test $i passed"; i=$((i+1)); sleep 0.2; done`,
          cwd: root,
          timeoutMs: 120_000,
          maxOutputBytes: 1 << 16,
          signal,
          taskId,
          outputPath: join(root, `${taskId}.out`),
          retainUntilMs: Date.now() + 600_000,
        });
      return ref;
    };
    const first = await start("suite-a");
    const sibling = await start("suite-b");
    expect(await backend.background.status(handle, first, signal)).toEqual({ state: "running" });
    let tail: Awaited<ReturnType<MacOperationBackend["background"]["tail"]>> = {
      unavailable: "lost",
    };
    for (let i = 0; i < 200; i++) {
      tail = await backend.background.tail(handle, first, { maxBytes: 4096, signal });
      if ("data" in tail && Buffer.from(tail.data).toString().includes("suite-a test 1 passed"))
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect("data" in tail && Buffer.from(tail.data).toString()).toContain("suite-a test 1 passed");
    expect(await backend.background.stop(handle, first, { graceMs: 1000, signal })).toEqual({
      outcome: "stopped",
    });
    expect((await backend.background.status(handle, first, signal)).state).toBe("exited");
    // the sibling keeps running: the stop ended exactly the ref it was given
    expect(await backend.background.status(handle, sibling, signal)).toEqual({
      state: "running",
    });
    expect(
      (await backend.background.stop(handle, sibling, { graceMs: 1000, signal })).outcome,
    ).toBe("stopped");
  });

  it("runs Full access only while the owner ceiling allows it", async () => {
    const full: SandboxPermissionGrant = {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    };
    const run = async () =>
      (await fixture.operation(full)).exec({
        command: "printf full-ok",
        cwd: root,
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
        signal: new AbortController().signal,
      });
    expect((await run()).stdout).toBe("full-ok");
    const allowed = ceiling;
    ceiling = { ...ceiling, revision: "two", outsideSandbox: false };
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      ceiling = allowed;
    }
  });
});
