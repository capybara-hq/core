import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { createDualReplicaHarness, type Harness } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import type { DeviceTargets } from "../../src/local-devices/targets.js";
import { createLogger } from "../../src/log.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";
import { FakeMachine } from "./fake-machine.js";

/**
 * Device connections across replicas (environments spec §13.4): the socket lives on a gateway
 * replica under the device's lease (the newest connection wins across replicas), and calls
 * relayed from any other replica reach it through Redis.
 */

const GRACE_SECONDS = 5;
const EXEC_RESULT = { exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, timedOut: false };
const execArgs = {
  command: "echo hi",
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  tag: "t1",
  actor: { accountId: "a", conversationId: "c" },
  limits: {
    cpu: 1,
    memoryMb: 512,
    diskMb: 1024,
    mode: "sandbox" as const,
    network: { kind: "allowlist" as const, hosts: [] },
  },
};

let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

type Json = Record<string, unknown>;

/**
 * An api+worker replica and a gateway replica; the owner signs a machine in through the device
 * flow on the api replica. Returns the harness, the org, the device and its credential.
 */
async function setup() {
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    roles: [["api", "worker"], ["gateway"]],
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      devices: { local: { reconnectGraceSeconds: GRACE_SECONDS, leaseTtlMs: 6000 } },
    },
  });
  const harness = h;
  const raw = createDb(harness.dbUrl, 2);
  cleanups.push(() => raw.destroy());
  const redis = new Redis(harness.redisUrl);
  cleanups.push(() => redis.disconnect());

  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await harness.request(path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (path === "/api/v1/auth/login") {
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
  };

  await accountsFor(kernelDb(raw)).createLocal({ login: "owner", password: PW, displayName: "O" });
  expect((await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status).toBe(
    200,
  );
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status).toBe(201);
  const orgId = (org.json.org as { id: string }).id;

  const a = await call("POST", "/api/v1/device/authorize", {
    name: "box",
    os: "linux",
    arch: "x64",
    programVersion: "0.1.0",
  });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const c = await call("POST", "/api/v1/device/confirm", {
    userCode: a.json.userCode,
    orgId,
    name: "Box",
  });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await call("POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  const { credential, deviceId } = t.json as { credential: string; deviceId: string };
  return { harness, redis, call, orgId, credential, deviceId };
}

const wsUrl = (port: number) => `ws://127.0.0.1:${port}/device/connect`;

describe("device connections on gateway replicas (dual replica)", () => {
  it("newest connection wins across gateway replicas", async () => {
    const { harness, redis, credential, deviceId } = await setup();
    const extra = await harness.startExtraReplica(["gateway"]);
    const first = new FakeMachine(wsUrl(harness.replicas[1].port), credential);
    cleanups.push(() => first.close());
    await first.opened;
    const firstToken = await waitFor(() => redis.get(deviceLeaseKey(deviceId)));

    const second = new FakeMachine(wsUrl(extra.port), credential);
    cleanups.push(() => second.close());
    await second.opened;
    expect((await first.closed).code).toBe(4002);
    const secondToken = await waitFor(async () => {
      const v = await redis.get(deviceLeaseKey(deviceId));
      return v !== null && v !== firstToken ? v : null;
    });
    // the newer connection keeps holding: exactly one holder, still the second
    await sleep(2000);
    expect(second.ws.readyState).toBe(second.ws.OPEN);
    expect(await redis.get(deviceLeaseKey(deviceId))).toBe(secondToken);
  }, 120_000);

  it("a relayed call from the api replica reaches the socket on the gateway replica", async () => {
    const { harness, redis, call, orgId, credential, deviceId } = await setup();
    const machine = new FakeMachine(wsUrl(harness.replicas[1].port), credential, (req) =>
      req.op === "exec" ? { ok: true, result: EXEC_RESULT } : undefined,
    );
    cleanups.push(() => machine.close());
    await machine.opened;
    await waitFor(() => redis.get(deviceLeaseKey(deviceId)));

    // a waited call through the shared Redis, by the relay every replica runs
    const sub = createBusSubscriber(() => new Redis(harness.redisUrl));
    cleanups.push(() => sub.close());
    const bus: ExtensionContext["bus"] = createBus(redis, sub, "kernel");
    const log = createLogger("error", { write: () => {} });
    const relay = new LocalDeviceRelay(
      redis,
      bus,
      new LockService(redis, log),
      {
        get: () => ({ devices: { local: { reconnectGraceSeconds: GRACE_SECONDS } } }),
      } as unknown as KernelConfigService,
      log,
      { state: async () => "active" } as Pick<DeviceTargets, "state"> as DeviceTargets,
    );
    expect(
      await relay.call(deviceId, "exec", execArgs, {
        deadlineMs: 6000,
        signal: AbortSignal.timeout(20_000),
      }),
    ).toEqual(EXEC_RESULT);

    // the api replica disconnects the machine: its stop frame, then the close
    const del = await call("DELETE", `/api/v1/orgs/${orgId}/devices/${deviceId}/machine`);
    expect(del.status, JSON.stringify(del.json)).toBe(204);
    expect(await machine.next((f) => f.type === "req" && f.op === "stop")).toMatchObject({
      args: { reason: "revoked" },
    });
    expect((await machine.closed).code).toBe(4003);
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(deviceId))) === null,
      10_000,
      "lease released",
    );
  }, 120_000);
});
