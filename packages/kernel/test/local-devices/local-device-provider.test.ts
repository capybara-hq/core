import { randomUUID } from "node:crypto";
import type { ExtensionContext, KernelReq, SandboxLimits } from "@capybara-hq/plugin-sdk";
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
import { LOCAL_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { type Answer, TestHolder } from "./test-holder.js";

/**
 * The kernel-internal `@local` provider (environments spec §13.5): `sandbox@2` over the relay,
 * handles keyed by the device id (ruling R1), cleanup paths safe while offline (ruling R9),
 * the files never touched (ruling R24), the org's current limits on every exec (ruling R27).
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
  egress: "allowlist",
  allowHosts: ["example.com"],
};
const ROOTS = {
  workspace: "/home/me/env/workspace",
  skills: "/home/me/env/skills",
  tmp: "/home/me/env/tmp",
};
/** What the stubbed PG reads answer: the org's limits now, the machine's roots, the org. */
let orgLimits: SandboxLimits;
let machineRoots: typeof ROOTS | null;
let orgOfEnv: string | null;
let maxFrameBytes: number;
beforeEach(() => {
  orgLimits = LIMITS;
  machineRoots = ROOTS;
  orgOfEnv = "org-1";
  maxFrameBytes = 16 * 1024 * 1024;
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
    { orgLimits: async () => orgLimits } as Pick<SandboxService, "orgLimits">,
    {
      get: () => ({ devices: { local: { maxFrameBytes } } }),
    } as unknown as KernelConfigService,
  );
}, 120_000);
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

  it("exec, readFile, writeFile and stat relay with bytes as base64", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    const actor = { accountId: "a", conversationId: "c" };
    const r = await provider.exec(handle, {
      command: "ls",
      timeoutMs: 7000,
      maxOutputBytes: 100,
      tag: "tag-1",
      actor,
      signal: signal(),
    });
    expect(r).toEqual(EXEC_RESULT);
    expect(h.frames[0]).toMatchObject({
      op: "exec",
      deadlineMs: 12_000,
      args: {
        command: "ls",
        timeoutMs: 7000,
        maxOutputBytes: 100,
        tag: "tag-1",
        actor,
        limits: LIMITS,
      },
    });
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    await provider.writeFile(handle, `${ROOTS.workspace}/a.bin`, data, signal());
    expect((h.frames[1] as KernelReq).args).toEqual({
      path: `${ROOTS.workspace}/a.bin`,
      dataB64: Buffer.from(data).toString("base64"),
    });
    const read = await provider.readFile(handle, `${ROOTS.workspace}/a.bin`, {
      maxBytes: 10,
      signal: signal(),
    });
    expect(read).toEqual({ data, truncated: false });
    expect(await provider.readFile(handle, "/nope", { maxBytes: 10, signal: signal() })).toBeNull();
    expect(await provider.stat(handle, `${ROOTS.workspace}/a.bin`, signal())).toEqual({
      size: 5,
      isDir: false,
    });
    await provider.killTagged(handle, ["tag-1"], signal());
    await provider.killAll(handle, signal());
    expect(h.frames.slice(-2)).toMatchObject([
      { op: "killTagged", args: { tags: ["tag-1"] }, deadlineMs: 30_000 },
      { op: "killAll", args: {}, deadlineMs: 30_000 },
    ]);
    await h.disconnect();
  });

  it("an exec aborted after it was sent resolves with exitCode null and cancels on the machine", async () => {
    const h = new TestHolder(redis, bus, randomUUID());
    await h.connect();
    const ac = new AbortController();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    const run = provider.exec(handle, {
      command: "sleep 9",
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      tag: "t",
      actor: { accountId: "a", conversationId: "c" },
      signal: ac.signal,
    });
    const req = await h.next();
    ac.abort(new Error("stop"));
    expect(await run).toEqual({
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    expect(await h.next((f) => f.type === "cancel")).toEqual({ type: "cancel", id: req.id });
    await h.disconnect();
  });

  it("exec carries the org's limits of the moment, not the handle's (ruling R27)", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    const args = {
      command: "ls",
      timeoutMs: 1000,
      maxOutputBytes: 10,
      tag: "t",
      actor: { accountId: "a", conversationId: "c" },
    };
    await provider.exec(handle, { ...args, signal: signal() });
    expect((h.frames[0] as KernelReq).args).toMatchObject({ limits: { egress: "allowlist" } });
    // the org's egress is turned off: the next exec carries it
    orgLimits = { ...LIMITS, egress: "none", allowHosts: [] };
    await provider.exec(handle, { ...args, signal: signal() });
    expect((h.frames[1] as KernelReq).args).toMatchObject({
      limits: { egress: "none", allowHosts: [] },
    });
    await h.disconnect();
  });

  it("readFile asks for no more than fits in one frame (ruling R26)", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.deviceId, roots: ROOTS, limits: LIMITS };
    maxFrameBytes = FRAME_ENVELOPE_BYTES + 400;
    expect(maxReadBytes(maxFrameBytes)).toBe(300);
    await provider.readFile(handle, "/x", { maxBytes: 10_000, signal: signal() });
    expect((h.frames[0] as KernelReq).args).toEqual({ path: "/x", maxBytes: 300 });
    maxFrameBytes = 16 * 1024 * 1024;
    await provider.readFile(handle, "/x", { maxBytes: 10_000, signal: signal() });
    expect((h.frames[1] as KernelReq).args).toEqual({ path: "/x", maxBytes: 10_000 });
    await h.disconnect();
  });

  it("exec in a deleted device is not found", async () => {
    orgOfEnv = null;
    const e = await rejection(
      provider.exec(
        { id: randomUUID(), roots: ROOTS },
        {
          command: "ls",
          timeoutMs: 1000,
          maxOutputBytes: 10,
          tag: "t",
          actor: { accountId: "a", conversationId: "c" },
          signal: signal(),
        },
      ),
    );
    expect(e instanceof ApiError && e.code === "device.not_found").toBe(true);
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
  }, 120_000);
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
