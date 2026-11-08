import { randomUUID } from "node:crypto";
import type { ExtensionContext, KernelReq, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { DeviceSandboxProvider, STOP_STEP_TIMEOUT_MS } from "../../src/devices/device-provider.js";
import { deviceReqKey } from "../../src/devices/keys.js";
import { DeviceRelay } from "../../src/devices/relay.js";
import { ApiError } from "../../src/errors.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { DEVICE_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
import { type Answer, TestHolder } from "./test-holder.js";

/**
 * The kernel-internal `@device` provider (environments spec §13.5): `sandbox@2` over the relay,
 * handles keyed by the environment id (ruling R1), cleanup paths safe while offline (ruling R9).
 */

let rd: TestContainer;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let bus: ExtensionContext["bus"];
let provider: DeviceSandboxProvider;
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
const EXEC_RESULT = { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false };
const signal = () => AbortSignal.timeout(30_000);
const isOffline = (e: unknown) => e instanceof ApiError && e.code === "environment.offline";
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
  const relay = new DeviceRelay(
    redis,
    bus,
    new LockService(redis, log),
    {
      get: () => ({ environments: { device: { reconnectGraceSeconds: 2 } } }),
    } as unknown as KernelConfigService,
    log,
  );
  provider = new DeviceSandboxProvider(relay, log);
}, 120_000);
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await rd?.stop();
});

describe("DeviceSandboxProvider", () => {
  it("declares concurrent exec and no session isolation", () => {
    expect(provider.concurrentExec).toBe(true);
    expect(provider.sessionIsolation).toBe(false);
  });

  it("createFileSystem returns the environment id without asking the machine (offline too)", async () => {
    const env = randomUUID();
    const fs = await provider.createFileSystem({
      name: `cap-env-${env}`,
      limits: LIMITS,
      signal: signal(),
    });
    expect(fs).toEqual({ id: env });
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
  });

  it("create relays create and returns the environment id, the machine's roots and the limits", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = await provider.create({
      name: `cap-env-${h.environmentId}`,
      limits: LIMITS,
      fileSystem: { id: h.environmentId },
      signal: signal(),
    });
    expect(handle).toEqual({ id: h.environmentId, roots: ROOTS, limits: LIMITS });
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
        name: `cap-env-${env}`,
        limits: LIMITS,
        fileSystem: { id: env },
        signal: signal(),
      }),
    );
    expect(isOffline(created)).toBe(true);
    expect(isOffline(await rejection(provider.resume({ id: env }, signal())))).toBe(true);
    const h = new TestHolder(redis, bus, env, machine());
    await h.connect();
    expect(await provider.resume({ id: env }, signal())).toBe("resumed");
    await h.disconnect();
  });

  it("exec, readFile, writeFile and stat relay with bytes as base64", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    const handle = { id: h.environmentId, roots: ROOTS, limits: LIMITS };
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
    const handle = { id: h.environmentId, roots: ROOTS, limits: LIMITS };
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

  it("exec on a handle without limits reports the instance gone (the kernel recreates it)", async () => {
    const e = await rejection(
      provider.exec(
        { id: randomUUID() },
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
    expect((e as Error).name).toBe("SandboxGoneError");
  });

  it("suspend, destroy and the file system cleanup never fail while offline", async () => {
    const env = randomUUID();
    const handle = { id: env, roots: ROOTS, limits: LIMITS };
    await provider.suspend(handle, signal());
    await provider.destroy(handle, signal());
    await provider.destroyByName(`cap-env-${env}`, signal());
    await provider.destroyFileSystem({ id: env }, signal());
    await provider.destroyFileSystemByName(`cap-env-${env}`, signal());
    await provider.destroyFileSystemByName("cap-legacy-conversation", signal());
    expect(await redis.exists(deviceReqKey(env))).toBe(0);
  });

  it("deleting the file system tells a connected machine to stop; destroy does not", async () => {
    const h = new TestHolder(redis, bus, randomUUID(), machine());
    await h.connect();
    await provider.destroy({ id: h.environmentId }, signal());
    await provider.suspend({ id: h.environmentId }, signal());
    expect(h.frames).toEqual([]);
    await provider.destroyFileSystem({ id: h.environmentId }, signal());
    await provider.destroyFileSystemByName(`cap-env-${h.environmentId}`, signal());
    await vi.waitFor(() =>
      expect(h.frames).toMatchObject([
        { op: "stop", args: { reason: "deleted" } },
        { op: "stop", args: { reason: "deleted" } },
      ]),
    );
    await h.disconnect();
  });

  it("stop is fire-and-forget: a live machine that never answers does not delay deletion", async () => {
    const h = new TestHolder(redis, bus, randomUUID());
    await h.connect();
    const t0 = Date.now();
    await provider.destroyFileSystem({ id: h.environmentId }, signal());
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await h.next()).toMatchObject({ op: "stop", args: { reason: "deleted" } });
    await h.disconnect();
  });

  it("a Redis failure while telling the machine does not fail the deletion", async () => {
    const broken = new DeviceSandboxProvider(
      {
        holderLive: async () => true,
        send: async () => {
          throw new Error("redis down");
        },
      } as unknown as DeviceRelay,
      log,
    );
    await broken.destroyFileSystem({ id: randomUUID() }, signal());
    const offlineCheckFails = new DeviceSandboxProvider(
      {
        holderLive: async () => {
          throw new Error("redis down");
        },
      } as unknown as DeviceRelay,
      log,
    );
    await offlineCheckFails.destroyFileSystemByName(`cap-env-${randomUUID()}`, signal());
  });

  it("a hung Redis delays deletion by at most the step timeout", async () => {
    const hung = new DeviceSandboxProvider(
      { holderLive: () => new Promise<boolean>(() => {}) } as unknown as DeviceRelay,
      log,
    );
    const t0 = Date.now();
    await hung.destroyFileSystem({ id: randomUUID() }, signal());
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(STOP_STEP_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(STOP_STEP_TIMEOUT_MS + 1000);
    const sendHangs = new DeviceSandboxProvider(
      {
        holderLive: async () => true,
        send: () => new Promise<void>(() => {}),
      } as unknown as DeviceRelay,
      log,
    );
    const t1 = Date.now();
    await sendHangs.destroyFileSystemByName(`cap-env-${randomUUID()}`, signal());
    expect(Date.now() - t1).toBeLessThan(STOP_STEP_TIMEOUT_MS + 1000);
  }, 20_000);
});

describe("DevicesModule", () => {
  let pgc: TestContainer;
  let krd: TestContainer;
  beforeAll(async () => {
    [pgc, krd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([pgc?.stop(), krd?.stop()]);
  });

  it.each([["api"], ["worker"], ["gateway"]])(
    "registers @device on the %s role",
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
        const entry = app.get(SandboxProviders, { strict: false }).forName(DEVICE_PROVIDER);
        expect(entry?.plugin).toBe(DEVICE_PROVIDER);
        expect(entry?.impl).toBeInstanceOf(DeviceSandboxProvider);
      } finally {
        await closeKernelApp(app);
      }
    },
    60_000,
  );
});
