import { randomUUID } from "node:crypto";
import type {
  DeviceExecGrants,
  ExtensionContext,
  KernelReq,
  SandboxLimits,
} from "@capybara-hq/plugin-sdk";
import { SandboxPermissionUnsupportedError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { ApiError } from "../../src/errors.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { deviceReqKey } from "../../src/local-devices/keys.js";
import {
  FRAME_ENVELOPE_BYTES,
  LocalDeviceProvider,
  maxReadBytes,
} from "../../src/local-devices/local-device-provider.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import type { DeviceTargets } from "../../src/local-devices/targets.js";
import { createLogger } from "../../src/log.js";
import {
  type DeploymentDevicePolicy,
  effectiveDevicePolicy,
  type OrgDeviceSettings,
} from "../../src/sandbox/modes.js";
import { LOCAL_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { type Answer, TestHolder } from "./test-holder.js";

/**
 * The kernel-internal `@local` provider (environments spec §13.5): `sandbox@2` over the relay,
 * handles keyed by the device id (ruling R1), cleanup paths safe while offline (ruling R9),
 * the files never touched (ruling R24), the org's current limits and mode on every exec (ruling
 * R27, auto mode spec §4.2).
 */

let rd: TestContainer;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let bus: ExtensionContext["bus"];
let provider: LocalDeviceProvider;
const log = createLogger("error", { write: () => {} });

const LIMITS: SandboxLimits = {
  cpu: 2,
  memoryMb: 1024,
  diskMb: 2048,
  network: { kind: "allowlist", hosts: ["example.com"] },
};
const ROOTS = {
  workspace: "/home/me/env/workspace",
  skills: "/home/me/env/skills",
  tmp: "/home/me/env/tmp",
};
/** The deployment's switch and network (auto allowed, the allowlist unless a test changes it). */
const DEPLOYMENT: DeploymentDevicePolicy = {
  fullAccess: "allowed",
  limits: { egress: "allowlist", allowHosts: ["example.com"], orgHosts: "extend" },
};
/** What the stubbed PG reads answer: the platform policy and the org's settings. */
let deployment: DeploymentDevicePolicy;
let orgSettings: OrgDeviceSettings;
let machineRoots: typeof ROOTS | null;
let orgOfEnv: string | null;
let maxFrameBytes: number;
/** What the admitted call grants answer. */
let admittedGrants: DeviceExecGrants | undefined;
beforeEach(() => {
  deployment = structuredClone(DEPLOYMENT);
  orgSettings = {};
  machineRoots = ROOTS;
  orgOfEnv = "org-1";
  maxFrameBytes = 16 * 1024 * 1024;
  admittedGrants = undefined;
});
const EXEC_RESULT = { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false };
const signal = () => AbortSignal.timeout(30_000);
const isOffline = (e: unknown) => e instanceof ApiError && e.code === "device.offline";
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/** A machine with a small in-memory file system that answers every op. */
function machine(): (req: KernelReq) => Answer {
  const files = new Map<string, string>();
  return (req) => {
    const a = req.args as Record<string, unknown>;
    switch (req.op) {
      case "create":
        return { ok: true, result: { roots: ROOTS } };
      case "exec":
        return { ok: true, result: EXEC_RESULT };
      case "writeFile":
        files.set(a.path as string, a.dataB64 as string);
        return { ok: true, result: null };
      case "readFile": {
        const d = files.get(a.path as string);
        return { ok: true, result: d === undefined ? null : { dataB64: d, truncated: false } };
      }
      case "list":
        return a.path === "/missing"
          ? { ok: true, result: null }
          : a.path === `${ROOTS.workspace}/file.txt`
            ? { ok: false, error: { kind: "error", message: "not a directory" } }
            : { ok: true, result: { entries: [{ name: "src", isDir: true }], truncated: true } };
      case "scan":
        return {
          ok: true,
          result: [{ path: `${ROOTS.workspace}/app`, suggestedName: "app" }],
        };
      case "stat": {
        const d = files.get(a.path as string);
        return {
          ok: true,
          result: d === undefined ? null : { size: Buffer.from(d, "base64").length, isDir: false },
        };
      }
      default:
        return { ok: true, result: null };
    }
  };
}

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  bus = createBus(redis, sub, "kernel");
  const relay = new LocalDeviceRelay(
    redis,
    bus,
    new LockService(redis, log),
    {
      get: () => ({ devices: { local: { reconnectGraceSeconds: 2 } } }),
    } as unknown as KernelConfigService,
    log,
    { state: async () => "active" } as Pick<DeviceTargets, "state"> as DeviceTargets,
  );
  provider = new LocalDeviceProvider(
    relay,
    {
      orgOf: async () => orgOfEnv,
      machineRoots: async () => machineRoots,
    },
    {
      devicePolicy: async () => effectiveDevicePolicy(deployment, orgSettings, null),
      deviceLimits: async (_d, o = {}) => {
        const p = o.policy ?? effectiveDevicePolicy(deployment, orgSettings, null);
        return {
          cpu: 2,
          memoryMb: 1024,
          diskMb: 2048,
          mode: p.allowedMode,
          network: { kind: "allowlist", hosts: [...p.localAllowedDomains] },
        };
      },
    } as Pick<SandboxService, "devicePolicy" | "deviceLimits">,
    {
      get: () => ({ devices: { local: { maxFrameBytes } } }),
    } as unknown as KernelConfigService,
    {
      forExecution: async () => admittedGrants,
    } as unknown as import("../../src/sandbox/permission-call-grants.js").PermissionCallGrants,
  );
});
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await rd?.stop();
});

describe("LocalDeviceProvider", () => {
  it("declares concurrent exec and no session isolation", () => {
    expect(provider.concurrentExec).toBe(true);
    expect(provider.sessionIsolation).toBe(false);
  });

  it("createFileSystem returns the device id without asking the machine (offline too)", async () => {
    const env = randomUUID();
    const fs = await provider.createFileSystem({
      name: `cap-device-${env}`,
      limits: LIMITS,
      signal: signal(),
    });
    expect(fs).toEqual({ id: env });
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
  });

  it("create relays create and returns the device id, the machine's roots and the limits", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = await provider.create({
      name: `cap-device-${h.deviceId}`,
      limits: LIMITS,
      fileSystem: { id: h.deviceId },
      signal: signal(),
    });
    expect(handle).toEqual({ id: h.deviceId, roots: ROOTS, limits: LIMITS });
    expect(h.frames[0]).toMatchObject({
      op: "create",
      args: { limits: LIMITS },
      deadlineMs: 30_000,
    });
    await h.disconnect();
  });

  it("create and resume need the machine online", async () => {
    const env = randomUUID();
    const created = await rejection(
      provider.create({
        name: `cap-device-${env}`,
        limits: LIMITS,
        fileSystem: { id: env },
        signal: signal(),
      }),
    );
    expect(isOffline(created)).toBe(true);
    const handle = { id: env, roots: ROOTS, limits: LIMITS };
    expect(isOffline(await rejection(provider.resume(handle, signal())))).toBe(true);
    const h = new TestHolder(redis, bus, env, machine());
    await h.connect();
    expect(await provider.resume(handle, signal())).toBe("resumed");
    await h.disconnect();
  });

  it("resume reports gone when the machine now reports other roots (ruling R23)", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    machineRoots = { ...ROOTS, workspace: "/home/me/other/workspace" };
    expect(await provider.resume(handle, signal())).toBe("gone");
    // no roots reported yet: nothing to compare
    machineRoots = null;
    expect(await provider.resume(handle, signal())).toBe("resumed");
    // a handle without roots cannot be the machine's instance
    expect(await provider.resume({ id: h.deviceId }, signal())).toBe("gone");
    await h.disconnect();
  });

  it("the raw protocol 2 methods refuse before anything is queued and kill nothing", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    const refused = [
      provider.exec(handle, {
        command: "ls",
        timeoutMs: 1000,
        maxOutputBytes: 10,
        tag: "t",
        actor: { accountId: "a", conversationId: "c" },
        signal: signal(),
      }),
      provider.readFile(handle, `${ROOTS.workspace}/a`, { maxBytes: 10, signal: signal() }),
      provider.writeFile(handle, `${ROOTS.workspace}/a`, new Uint8Array([1]), signal()),
      provider.stat(handle, ROOTS.workspace, signal()),
      provider.list(handle, ROOTS.workspace, {
        limit: 10,
        signal: signal(),
      }),
      provider.scan(handle, ROOTS.workspace, { signal: signal() }),
    ];
    for (const r of await Promise.allSettled(refused)) {
      expect(r).toMatchObject({ status: "rejected" });
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SandboxPermissionUnsupportedError);
    }
    await provider.killAll(handle, signal());
    await provider.killTagged(handle, ["t"], signal());
    expect(h.frames).toEqual([]);
    expect(await redis.exists(deviceReqKey(h.deviceId))).toBe(0);
    await h.disconnect();
  });

  it("suspend, destroy and the file system cleanup never fail while offline", async () => {
    const env = randomUUID();
    const handle = { id: env, roots: ROOTS, limits: LIMITS };
    await provider.suspend(handle, signal());
    await provider.destroy(handle, signal());
    await provider.destroyByName(`cap-device-${env}`, signal());
    await provider.destroyFileSystem({ id: env }, signal());
    await provider.destroyFileSystemByName(`cap-device-${env}`, signal());
    await provider.destroyFileSystemByName("cap-legacy-conversation", signal());
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
  });

  it("suspend, destroy and the file system cleanup never reach a connected machine", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const env = h.deviceId;
    await provider.destroy({ id: env }, signal());
    await provider.suspend({ id: env }, signal());
    await provider.destroyFileSystem({ id: env }, signal());
    await provider.destroyFileSystemByName(`cap-device-${env}`, signal());
    await new Promise((r) => setTimeout(r, 200));
    expect(h.frames).toEqual([]);
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
    await h.disconnect();
  });
});

describe("LocalDevicesModule", () => {
  let pgc: TestContainer;
  let krd: TestContainer;
  beforeAll(async () => {
    [pgc, krd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  });
  afterAll(async () => {
    await Promise.all([pgc?.stop(), krd?.stop()]);
  });

  it.each([["api"], ["worker"], ["gateway"]])(
    "registers @local on the %s role",
    async (role) => {
      const app = await createKernelApp(
        KernelConfigSchema.parse({
          db: { url: pgc.url, poolMax: 3 },
          redis: { url: krd.url },
          masterKey: Buffer.alloc(32, 7).toString("base64"),
          marketplaces: { official: { enabled: false } },
          http: { port: 0 },
          roles: [role],
        }),
        { env: {}, logger: createLogger("error", { write: () => {} }) },
      );
      try {
        const entry = app.get(SandboxProviders, { strict: false }).forName(LOCAL_PROVIDER);
        expect(entry?.plugin).toBe(LOCAL_PROVIDER);
        expect(entry?.impl).toBeInstanceOf(LocalDeviceProvider);
      } finally {
        await closeKernelApp(app);
      }
    },
    60_000,
  );
});

it("a staged readFile asks for no more than fits in one frame (ruling R26)", async () => {
  const sent: { op: string; args: Record<string, unknown> }[] = [];
  const staged = provider.stagedOperations({
    call: async (_device, op, args) => {
      sent.push({ op, args });
      return null;
    },
    permissionSupport: async () => ({
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    }),
  });
  const signal = new AbortController().signal;
  const operation = await staged.operation(
    { id: "device" },
    {
      operationId: "operation",
      admitBeforeMs: Date.now() + 30000,
      deviceId: "device",
      rootConversationId: "root",
      profileRevision: 1,
      ceilingRevision: "c",
      profile: "approve-for-me",
      actor: { accountId: "owner", conversationId: "root" },
      tag: "operation",
      filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
      network: { kind: "allowlist", hosts: [] },
    },
    signal,
  );
  maxFrameBytes = FRAME_ENVELOPE_BYTES + 4000;
  await operation.readFile("/work/x", { maxBytes: 10_000, signal });
  maxFrameBytes = 16 * 1024 * 1024;
  await operation.readFile("/work/x", { maxBytes: 10_000, signal });
  const reads = sent.filter((c) => c.op === "readFile").map((c) => c.args.maxBytes);
  expect(reads).toEqual([maxReadBytes(FRAME_ENVELOPE_BYTES + 4000), 10_000]);
  expect(reads[0]).toBe(3000);
});

it.each(["exec", "backgroundStart"] as const)(
  "staged %s reuses recorded grants on a consumed retry without reading current run grants",
  async (method) => {
    const sent: Record<string, unknown>[] = [];
    const staged = provider.stagedOperations({
      call: async (_device, op, args) => {
        sent.push(args);
        if (op === "backgroundStart")
          return {
            instanceId: "device",
            instanceGeneration: "g",
            operationId: "operation",
            executionId: "execution",
          };
        return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
      },
      permissionSupport: async () => ({
        version: 2,
        restricted: null,
        boundary: "operation",
        network: { openPublic: false, allowlist: false, perOperationHosts: false },
        outsideSandbox: false,
        background: false,
      }),
    });
    const signal = new AbortController().signal;
    const scope = {
      operationId: "operation",
      admitBeforeMs: Date.now() + 30000,
      deviceId: "device",
      rootConversationId: "root",
      profileRevision: 1,
      ceilingRevision: "c",
      profile: "approve-for-me" as const,
      actor: { accountId: "owner", conversationId: "root", runId: "run" },
      tag: "operation",
      filesystem: { kind: "scoped" as const, readRoots: ["/work"], writeRoots: ["/work"] },
      network: { kind: "allowlist" as const, hosts: ["example.com"] },
    };
    const operation = await staged.operation({ id: "device" }, scope, signal);
    admittedGrants = {
      hosts: ["example.com"],
      source: { kind: "run", id: "run", accountId: "owner" },
    };
    const invoke = () =>
      method === "exec"
        ? operation.exec({ command: "true", timeoutMs: 100, maxOutputBytes: 100, signal })
        : staged.background.start({ id: "device" }, scope, {
            command: "true",
            timeoutMs: 100,
            maxOutputBytes: 100,
            signal,
            taskId: "task",
            outputPath: "/work/task.out",
            retainUntilMs: scope.admitBeforeMs + 1000,
          });
    await invoke();
    await invoke();
    expect(sent[0]?.grants).toEqual({
      hosts: ["example.com"],
      source: { kind: "run", id: "run", accountId: "owner" },
    });
    expect(sent[1]?.grants).toEqual(sent[0]?.grants);
    orgSettings = {
      deviceNetwork: { ceiling: "allowlist", excludedHosts: ["example.com"], extraHosts: [] },
    };
    await expect(invoke()).rejects.toThrow("Current organization limits refuse");
    expect(sent).toHaveLength(2);
  },
);

it("staged exec re-layers the machine's refused hosts against the limits it carried (spec §4.1)", async () => {
  const staged = provider.stagedOperations({
    call: async () => ({
      ...EXEC_RESULT,
      network: {
        blocked: [
          // the org allows it: the machine's word stands
          { host: "example.com", port: 443, layer: "device" },
          // the machine calls it its own; the org does not allow it: only an admin can lift it
          { host: "evil.example.net", port: 443, layer: "device" },
          { host: "other.org", port: 80, layer: "org" },
        ],
      },
    }),
    permissionSupport: async () => ({
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    }),
  });
  const signal = new AbortController().signal;
  const scope = {
    operationId: "operation",
    admitBeforeMs: Date.now() + 30000,
    deviceId: "device",
    rootConversationId: "root",
    profileRevision: 1,
    ceilingRevision: "c",
    profile: "approve-for-me" as const,
    actor: { accountId: "owner", conversationId: "root", runId: "run" },
    tag: "operation",
    filesystem: { kind: "scoped" as const, readRoots: ["/work"], writeRoots: ["/work"] },
    network: { kind: "none" as const },
  };
  admittedGrants = undefined;
  const operation = await staged.operation({ id: "device" }, scope, signal);
  const r = await operation.exec({ command: "curl", timeoutMs: 100, maxOutputBytes: 100, signal });
  expect(r.network?.blocked).toEqual([
    { host: "example.com", port: 443, layer: "device" },
    { host: "evil.example.net", port: 443, layer: "org" },
    { host: "other.org", port: 80, layer: "org" },
  ]);
});

it("staged exec: a wildcard the machine calls its own is an address, a bad name is dropped, no report stays none", async () => {
  let answer: Record<string, unknown> = {};
  const staged = provider.stagedOperations({
    call: async () => ({ ...EXEC_RESULT, ...answer }),
    permissionSupport: async () => ({
      version: 2,
      restricted: null,
      boundary: "operation",
      network: { openPublic: false, allowlist: false, perOperationHosts: false },
      outsideSandbox: false,
      background: false,
    }),
  });
  const signal = new AbortController().signal;
  const scope = {
    operationId: "operation",
    admitBeforeMs: Date.now() + 30000,
    deviceId: "device",
    rootConversationId: "root",
    profileRevision: 1,
    ceilingRevision: "c",
    profile: "approve-for-me" as const,
    actor: { accountId: "owner", conversationId: "root", runId: "run" },
    tag: "operation",
    filesystem: { kind: "scoped" as const, readRoots: ["/work"], writeRoots: ["/work"] },
    network: { kind: "none" as const },
  };
  admittedGrants = undefined;
  const operation = await staged.operation({ id: "device" }, scope, signal);
  const exec = () =>
    operation.exec({ command: "curl", timeoutMs: 100, maxOutputBytes: 100, signal });
  answer = {
    network: {
      blocked: [
        // a wildcard is never a host to ask about: nobody can allow it from a refusal
        { host: "*.example.com", port: 443, layer: "device" },
        // no valid host name: the codec drops it rather than asking the owner
        { host: "bad_host!", port: 443, layer: "device" },
        // an invalid name the machine itself calls an address is kept as one
        { host: "bad_host!", port: 80, layer: "address" },
      ],
    },
  };
  expect((await exec()).network?.blocked).toEqual([
    { host: "*.example.com", port: 443, layer: "address" },
    { host: "bad_host!", port: 80, layer: "address" },
  ]);
  // no report: nothing is invented
  answer = {};
  expect((await exec()).network).toBeUndefined();
});
