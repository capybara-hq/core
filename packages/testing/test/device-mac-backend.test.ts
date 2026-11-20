import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classifyAddress, type SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The device's own backend and test helpers (the device package may not depend on this one, so
// its macOS backend meets the harness here, as its Linux backends do in device-linux-backend).
import {
  createMacOperationBackend,
  type MacOperationBackend,
} from "../../device/src/exec/mac-operation-backend.js";
import type { DeviceOwnerCeiling } from "../../device/src/exec/operation-types.js";
import { startMacOperationWorker } from "../../device/src/exec/operation-worker.js";
import { TOOL_HOME_DIRS, toolHomeEnv } from "../../device/src/exec/shared.js";
import { sealWorkspaceRuntime } from "../../device/test/runtime-seal.js";
import type { NativeFixtureEntry } from "../src/sandbox-native-conformance.js";
import {
  runSandboxPermissionConformance,
  type SandboxPermissionEndpoint,
  type SandboxPermissionFixture,
  type SandboxPermissionGrant,
  type SandboxPermissionOpenNetwork,
  type SandboxPermissionTarget,
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
 * by-name positive is skipped (`namedReach: { unavailable }`, annotated on the test).
 *
 * The open network: the closed classes are probed as IP literals and through names the system
 * resolver knows (`localhost`, and `localtest.me`, a public name resolving to loopback: a DNS
 * rebinding name). The public positive needs the internet (`http://1.1.1.1/`, and `example.com` by
 * name); without it the positive is recorded as unavailable and every refusal still runs. Behind a
 * fake-IP resolver (a router answering every name with 198.18.0.0/15, detected from the system
 * resolver's answer for example.com) the names go through the proxy's DNS-over-HTTPS: example.com
 * must then be reached and localtest.me still refused.
 *
 * Not covered here, by design: the harness's `outside` probe (it reads Linux `/proc`); on macOS a
 * same-user process outside every operation may signal or trace the device's processes (a known
 * limitation of an escalated call sharing the device's OS user, recorded in the evidence report).
 */

const darwin = process.platform === "darwin";
const NAMES = {
  granted: "granted.permission.test",
  ungranted4: "ungranted4.permission.test",
  ungranted6: "ungranted6.permission.test",
} as const;
const DEVICE_ID = "device-mac";
/** A public name resolving to 127.0.0.1 (a DNS rebinding name for the open network). */
const REBINDING = "localtest.me";
/** Planted in the device program's environment: no sandboxed command may see them. */
const PLANTED = {
  AWS_SECRET_ACCESS_KEY: "planted-aws-secret-0d1e",
  CAPYBARA_TEST_DEVICE_TOKEN: "planted-capybara-token-7f3a",
  // an innocent-looking name: only a minimal environment keeps it out, never a denylist
  PLANTED_PLAIN: randomUUID(),
};

/** Whether `name` resolves (the system resolver) into the fake-IP range 198.18.0.0/15. */
async function fakeIpAnswer(name: string): Promise<boolean | null> {
  const answers = await lookup(name, { all: true }).catch(() => null);
  if (answers === null || answers.length === 0) return null;
  return answers.some((a) => a.family === 4 && /^198\.1[89]\./.test(a.address));
}

/** Whether this process gets an HTTP answer from `url` within 5 s (the internet is reachable). */
async function answers(url: string): Promise<boolean> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then(
    () => true,
    () => false,
  );
}

let dir = "";
let priorHome: string | undefined;
let priorPath: string | undefined;
let toolHome: { home: string; env: Record<string, string | undefined> } = { home: "", env: {} };
const priorPlanted: Record<string, string | undefined> = {};
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
  /** A fixture on fresh project and sibling directories (each conformance part needs its own). */
  let fresh: () => Promise<SandboxPermissionFixture>;

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
    await mkdir(root, { recursive: true });
    const key = join(home, ".ssh", "id_ed25519");
    const profile = join(home, ".zshrc");
    await writeFile(key, "synthetic-private-key\n", { mode: 0o600 });
    await writeFile(profile, "export SYNTHETIC=1\n");
    priorHome = process.env.HOME;
    priorPath = process.env.PATH;
    // the synthetic home stays the protected home; the version manager directories are the real
    // home's, named explicitly (as a device whose environment sets ASDF_DATA_DIR, ...)
    toolHome = { home, env: { ...process.env, ...toolHomeEnv(homedir(), process.env) } };
    process.env.HOME = home;
    // version manager shims resolve their versions from the real home: run the real binaries
    process.env.PATH = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      ":",
    );
    for (const [name, value] of Object.entries(PLANTED)) {
      priorPlanted[name] = process.env[name];
      process.env[name] = value;
    }

    // the open network: an allowlist scope then reaches exactly its own names (still never a
    // closed address class)
    ceiling = {
      revision: "one",
      outsideSandbox: true,
      network: "open",
      roots,
      restrictedProjectReach: "os-user",
      allowedDomains: [],
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
        // HOME is the synthetic home, where no version manager lives: the trusted seam names the
        // real installs a restricted command must read (the node first on PATH may be ~/.asdf's)
        startWorker: (request, signal) => startMacOperationWorker({ ...request, toolHome }, signal),
        watch: () => () => {},
      },
    );
    const granted = await endpoint(NAMES.granted, "127.0.0.1");
    const ungranted = [
      await endpoint(NAMES.ungranted4, "127.0.0.1"),
      await endpoint(NAMES.ungranted6, "::1"),
    ];
    const handle = { id: DEVICE_ID };
    const [v4, v6] = ungranted as [SandboxPermissionEndpoint, SandboxPermissionEndpoint];
    const loopback = (
      label: string,
      host: string,
      endpoint: SandboxPermissionEndpoint,
    ): SandboxPermissionTarget => ({
      label,
      host,
      port: endpoint.port,
      receipts: endpoint.receipts,
    });
    const literal = (label: string, host: string, port = 80): SandboxPermissionTarget => ({
      label,
      host,
      port,
    });
    const internet = (await answers("http://1.1.1.1/")) && (await answers("http://example.com/"));
    const fakeIp = await fakeIpAnswer("example.com");
    const rebinding = (await lookup(REBINDING).catch(() => null)) !== null;
    const publicName = literal("public-name", "example.com");
    const openNetwork: SandboxPermissionOpenNetwork = {
      ...(internet ? {} : { allowNoPositive: true as const }),
      reachable: internet
        ? [literal("public-literal", "1.1.1.1"), ...(fakeIp ? [] : [publicName])]
        : { unavailable: "this machine reaches no public address (offline run)" },
      closed: [
        loopback("loopback", "127.0.0.1", v4),
        loopback("loopback-other", "127.0.0.2", v4),
        loopback("localhost", "localhost", v4),
        loopback("loopback6", "::1", v6),
        loopback("mapped", "::ffff:127.0.0.1", v4),
        literal("private10", "10.0.0.1"),
        literal("private172", "172.16.0.1"),
        literal("private192", "192.168.1.1"),
        literal("cgnat", "100.64.0.1"),
        literal("ula", "fd12:3456::1"),
        literal("metadata", "169.254.169.254"),
        literal("metadata6", "fd00:ec2::254"),
        literal("link-local6", "fe80::1"),
        literal("nat64", "64:ff9b::a00:1"),
        literal("benchmark", "198.18.0.1"),
        literal("reserved", "240.0.0.1"),
        literal("multicast", "224.0.0.251"),
        literal("broadcast", "255.255.255.255"),
        literal("unspecified", "0.0.0.0", v4.port),
        ...(rebinding && !fakeIp ? [loopback("rebinding", REBINDING, v4)] : []),
      ],
      fakeIp: fakeIp
        ? {
            reachable: internet ? [publicName] : [],
            closed: rebinding ? [loopback("rebinding", REBINDING, v4)] : [],
          }
        : {
            unavailable:
              "this machine's resolver is no fake-IP resolver (device mac-srt-network-patch " +
              "covers the encrypted DNS offline)",
          },
    };
    // the classes the closed targets cover are the SDK's closed classes (a fixture sanity check)
    for (const target of openNetwork.closed)
      if (target.host !== "localhost" && target.host !== REBINDING)
        expect(classifyAddress(target.host), target.label).not.toBe("public");
    let projects = 0;
    fresh = async () => {
      const project = join(home, "code", `p${++projects}`);
      const sibling = join(home, "code", `s${projects}`);
      await mkdir(project, { recursive: true });
      await mkdir(sibling, { recursive: true });
      return { ...fixture, root: project, sibling };
    };
    fixture = {
      root,
      sibling: join(home, "code", "sibling"),
      protectedPaths: [key, profile],
      deviceEnvironment: {
        variables: PLANTED,
        escalatedControl: true,
        allowed: [
          // the sandbox runtime's own: its marker, and git, ssh and Java routed through its proxy
          // (an http.proxyAuthMethod setting, a SOCKS ProxyCommand, the proxy system properties)
          "SANDBOX_RUNTIME",
          "GIT_CONFIG_PARAMETERS",
          "GIT_SSH_COMMAND",
          "JAVA_TOOL_OPTIONS",
          // the tool homes the device passes through (version managers' data directories)
          ...TOOL_HOME_DIRS.map(([name]) => name),
        ],
      },
      withoutOutsideSandbox: async () => {
        const allowed = ceiling;
        ceiling = { ...ceiling, revision: "no-outside", outsideSandbox: false };
        return async () => {
          ceiling = allowed;
        };
      },
      home: { path: home, remove: (path) => rm(path, { force: true }) },
      openNetwork,
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
      endpoints: {
        granted,
        ungranted,
        access: "proxy",
        namedReach: {
          unavailable:
            "no hosts-file entry may lead the name to a loopback endpoint and the proxy refuses " +
            "loopback by design (device: overlapping workers keep their network grants)",
        },
        // allowlisted, yet resolving to loopback: refused by address
        closedGranted: rebinding
          ? [loopback("granted-rebinding", REBINDING, v4)]
          : { unavailable: `${REBINDING} does not resolve here (no DNS)` },
      },
      support: () => backend.permissionSupport(handle, new AbortController().signal),
      operation: async (grant) => {
        const scope = scopeFor(grant);
        const operation = await backend
          .forExecution({
            operationId: scope.operationId,
            orgNetwork: { kind: "open-public", hosts: [] },
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
    for (const [name, value] of Object.entries(priorPlanted))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await seal.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports restricted support from the real runtime, with the open network, outside and background work", async () => {
    const support = await fixture.support();
    expect(support).toMatchObject({
      restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
      boundary: "operation",
      network: { openPublic: true, allowlist: true, perOperationHosts: true },
      outsideSandbox: true,
      background: true,
    });
  });

  // the conformance in its three parts (one test each keeps every part within the test timeout)
  for (const part of ["filesystem", "network", "processes"] as const)
    it(`passes the permission conformance: ${part}`, async (context) => {
      const report = await runSandboxPermissionConformance(await fresh(), { parts: [part] });
      // what this machine could not prove is recorded on the test, never passed silently
      for (const { item, reason } of report.unavailable)
        await context.annotate(`unavailable: ${item}: ${reason}`);
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

  it("runs the escalated pair only while the owner ceiling allows it", async () => {
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
