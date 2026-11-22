import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDualReplicaHarness,
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  type Harness,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DEVICE_CLOSE } from "../../src/dial-in/gateway.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import { enableExtensions, PW, waitFor } from "../helpers/runs.js";

/**
 * The generic dial-in channel across replicas (device provider spec §5, environments spec §13.4),
 * on the `fake-dial-in` fixture provider: replica A (index 0) runs only the gateway role and holds
 * the machine's socket under the device's lease; replica B (index 1) runs api, worker and gateway.
 * Every call a test makes goes to B: the sign-in, the device routes and the fixture's request seam
 * (`POST /plugins/fake-dial-in/request`, `ctx.dialIn.request` on B), relayed through Redis to the
 * holder. A reconnect to B takes the device over from A.
 */

const GRACE_SECONDS = 2;
const PLUGIN = "fake-dial-in";
const HELLO = { revision: "r1", outsideSandbox: false };

let h: Harness;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
/** Where the replicas unpack the plugin (not under their working directory). */
let extensionsDir: string;
let cookie = "";
let orgId: string;
const open: FakeDialInMachine[] = [];

type Json = Record<string, unknown>;

/** A call to replica B (the only api replica) with the owner's session. */
async function call(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const res = await h.request(path, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(cookie !== "" && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(signal !== undefined && { signal }),
  });
  expect(res.replica).toBe(1);
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: (text === "" ? {} : JSON.parse(text)) as Json,
  };
}

beforeAll(async () => {
  // an optional preinstall: loaded on every replica, on only in the orgs that switch it on
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  extensionsDir = await mkdtemp(join(tmpdir(), "cap-dial-in-dual-"));
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    bootstrap: { dir: bootstrap.dir, manifest: bootstrap.manifest },
    roles: [["gateway"], ["api", "worker", "gateway"]],
    config: {
      auth: { cookieSecure: false },
      extensionHost: { dir: extensionsDir },
      http: { publicUrl: "https://cap.example" },
      devices: { maxPersonal: 50, dialIn: { reconnectGraceSeconds: GRACE_SECONDS } },
    },
  });
  raw = createDb(h.dbUrl, 2);
  redis = new Redis(h.redisUrl);

  await accountsFor(kernelDb(raw)).createLocal({ login: "owner", password: PW, displayName: "O" });
  const login = await call("POST", "/api/v1/auth/login", { login: "owner", password: PW });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  orgId = (org.json.org as { id: string }).id;
  await enableExtensions(raw, orgId, PLUGIN);
});

afterAll(async () => {
  for (const m of open.splice(0)) await m.close();
  // the pool goes before the harness drops its database
  await raw?.destroy();
  redis?.disconnect();
  await h?.stop();
  await bootstrap?.cleanup();
  if (extensionsDir) await rm(extensionsDir, { recursive: true, force: true });
});

/**
 * Signs a fake machine in on replica B like `capybara-device login` does: into a new device of
 * the fixture provider, or into `deviceId` (a new machine of an existing device).
 */
async function signIn(target: { name: string } | { deviceId: string }) {
  // sign-ins are rate limited per address: every one starts fresh
  const keys = await redis.keys("throttler:*");
  if (keys.length > 0) await redis.del(...keys);
  const a = await call("POST", "/api/v1/device/authorize", {
    name: "box",
    os: "linux",
    arch: "x64",
    programVersion: "0.0.0-fake",
    protocol: FAKE_DIAL_IN_PROTOCOL,
  });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const c = await call("POST", "/api/v1/device/confirm", {
    userCode: a.json.userCode,
    orgId,
    provider: PLUGIN,
    ...target,
  });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await call("POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return t.json as { credential: string; deviceId: string };
}

const wsUrl = (replica: 0 | 1) => `ws://127.0.0.1:${h.replicas[replica].port}/device/connect`;

/** Connects a machine to `replica` and waits until its lease is held (it is ready on `ready`). */
async function connect(replica: 0 | 1, credential: string, deviceId: string, hello = HELLO) {
  const m = await FakeDialInMachine.connect({ url: wsUrl(replica), credential, hello });
  open.push(m);
  await waitFor(() => redis.get(deviceLeaseKey(deviceId)), 10_000, "lease held");
  return m;
}

/** A new device of the fixture provider whose machine is connected to replica A. */
async function onA() {
  const signed = await signIn({ name: `Box ${randomUUID().slice(0, 8)}` });
  const machine = await connect(0, signed.credential, signed.deviceId);
  return { ...signed, machine };
}

type RequestResult =
  | { ok: true; body: unknown }
  | { ok: false; error: { name: string; message: string; code?: string; offline: boolean } };

/** `ctx.dialIn.request` made by the fixture on replica B. */
async function requestOnB(
  deviceId: string,
  body: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RequestResult> {
  const res = await call(
    "POST",
    `/plugins/${PLUGIN}/request`,
    { deviceId, body, ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }) },
    opts.signal,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as RequestResult;
}

/** `ctx.dialIn.online` asked by the fixture on replica B. */
async function onlineOnB(deviceId: string): Promise<boolean> {
  const res = await call("GET", `/plugins/${PLUGIN}/online?deviceId=${deviceId}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.online as boolean;
}

/** The device as replica B shows it. */
async function deviceOnB(deviceId: string) {
  const res = await call("GET", `/api/v1/orgs/${orgId}/devices/${deviceId}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.device as { online: boolean | null; report: { revision: string } | null };
}

/** What the fixture keeps in its `ctx.kv` (written on whichever replica ran the handler). */
const kv = (key: string) => redis.get(`cap:${PLUGIN}:kv:${key}`);
const until = (key: string, value: string) =>
  waitFor(async () => ((await kv(key)) === value ? true : null), 10_000, `${key} = ${value}`);

const deviceEpoch = async (deviceId: string): Promise<number> => {
  const r = await sql<{ revision: number }>`SELECT revision
    FROM capybara.permission_authority_epochs WHERE kind = 'device' AND id = ${deviceId}`.execute(
    raw,
  );
  return r.rows[0]?.revision ?? 0;
};

describe("the dial-in channel across replicas (dual replica)", () => {
  it("a request made on replica B reaches the machine held by replica A and resolves", async () => {
    const { deviceId, machine } = await onA();
    machine.onRequest((body) => ({ echoed: body }));
    expect(await onlineOnB(deviceId)).toBe(true);
    expect((await deviceOnB(deviceId)).online).toBe(true);

    expect(await requestOnB(deviceId, { op: "ping", n: 1 })).toEqual({
      ok: true,
      body: { echoed: { op: "ping", n: 1 } },
    });
    expect(machine.requests).toEqual([{ op: "ping", n: 1 }]);
  });

  it("a reconnect to replica B takes over: A closes 4002 and the provider's onClose says replaced", async () => {
    const { deviceId, credential, machine: first } = await onA();
    const firstLease = await redis.get(deviceLeaseKey(deviceId));
    const second = await FakeDialInMachine.connect({ url: wsUrl(1), credential, hello: HELLO });
    open.push(second);
    const closed = await first.closed;
    expect(closed.code).toBe(DEVICE_CLOSE.replaced);
    expect(first.stops).toEqual([]);
    await until(`closed:${deviceId}`, "replaced");
    await waitFor(
      async () => {
        const v = await redis.get(deviceLeaseKey(deviceId));
        return v !== null && v !== firstLease ? v : null;
      },
      10_000,
      "lease taken over",
    );

    // requests now reach the new connection, never the replaced one
    second.onRequest(() => "from B");
    expect(await requestOnB(deviceId, { op: "ping" })).toEqual({ ok: true, body: "from B" });
    expect(first.requests).toEqual([]);
    expect(second.requests).toEqual([{ op: "ping" }]);
    expect(await onlineOnB(deviceId)).toBe(true);
  });

  it("a report revision told on replica A moves the device epoch every replica checks approvals against", async () => {
    const { deviceId, machine } = await onA();
    await waitFor(
      async () => ((await deviceOnB(deviceId)).report?.revision === "r1" ? true : null),
      10_000,
      "first report stored",
    );
    const before = await deviceEpoch(deviceId);
    // an event frame on A: the fixture calls ctx.devices.reportChanged there
    await machine.send({ revision: "r2" });
    await waitFor(
      async () => ((await deviceOnB(deviceId)).report?.revision === "r2" ? true : null),
      10_000,
      "new report seen on B",
    );
    expect(await deviceEpoch(deviceId)).toBeGreaterThan(before);
    // the same revision again moves nothing
    const after = await deviceEpoch(deviceId);
    await machine.send({ revision: "r2", marker: "again" });
    await waitFor(async () => {
      const frame = await kv(`frame:${deviceId}`);
      return frame !== null && JSON.parse(frame).marker === "again" ? true : null;
    });
    expect((await deviceOnB(deviceId)).report?.revision).toBe("r2");
    expect(await deviceEpoch(deviceId)).toBe(after);
  });

  it("a request given up on replica B is cancelled on the machine held by replica A", async () => {
    const { deviceId, machine } = await onA();
    // the machine takes the request and never answers
    machine.onRequest(() => new Promise(() => {}));
    const ac = new AbortController();
    const pending = requestOnB(deviceId, { op: "slow" }, { timeoutMs: 600_000, signal: ac.signal });
    pending.catch(() => {});
    await waitFor(async () => (machine.requests.length > 0 ? true : null), 10_000, "req taken");
    // the client goes away: the route's signal aborts ctx.dialIn.request on B
    ac.abort();
    await expect(pending).rejects.toThrow();
    await waitFor(async () => (machine.cancels.length > 0 ? true : null), 10_000, "cancel sent");
    expect(machine.cancels).toHaveLength(1);
    const error = JSON.parse((await waitFor(() => kv(`request-error:${deviceId}`))) ?? "{}");
    expect(error.offline).toBe(false);
    expect(error.name).toBe("AbortError");
  });

  it("a machine gone from replica A is offline on B and ctx.dialIn.request throws DeviceOfflineError", async () => {
    const { deviceId, machine } = await onA();
    await machine.close();
    await until(`closed:${deviceId}`, "offline");
    await waitFor(
      async () => ((await redis.get(deviceLeaseKey(deviceId))) === null ? true : null),
      10_000,
      "lease released",
    );
    expect(await onlineOnB(deviceId)).toBe(false);
    expect((await deviceOnB(deviceId)).online).toBe(false);
    const res = await requestOnB(deviceId, { op: "ping" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatchObject({
      name: "DeviceOfflineError",
      offline: true,
    });
  });

  it("signing the device in from another machine on B closes the old one 4002 on A without a stop", async () => {
    const { deviceId, machine: old } = await onA();
    const next = await signIn({ deviceId });
    expect(next.deviceId).toBe(deviceId);
    const closed = await old.closed;
    expect(closed.code).toBe(DEVICE_CLOSE.replaced);
    // no stop reaches the replaced machine (it could reach the replacement instead)
    expect(old.stops).toEqual([]);
    await until(`closed:${deviceId}`, "replaced");
    // the new machine's credential connects (to A) and serves the device
    await waitFor(
      async () => ((await redis.get(deviceLeaseKey(deviceId))) === null ? true : null),
      10_000,
      "lease released",
    );
    const replacement = await connect(0, next.credential, deviceId, {
      revision: "r2",
      outsideSandbox: false,
    });
    replacement.onRequest(() => "new machine");
    expect(await requestOnB(deviceId, { op: "ping" })).toEqual({ ok: true, body: "new machine" });
    expect(old.requests).toEqual([]);
  });

  it("deleting the device on B closes 4003 on A; ctx.dialIn.request then refuses it", async () => {
    const { deviceId, machine } = await onA();
    const del = await call("DELETE", `/api/v1/orgs/${orgId}/devices/${deviceId}`);
    expect(del.status, JSON.stringify(del.json)).toBe(202);
    const closed = await machine.closed;
    expect(closed).toEqual({ code: DEVICE_CLOSE.revoked, reason: "the device was deleted" });
    expect(machine.stops).toEqual(["stop"]);
    await until(`closed:${deviceId}`, "deleted");
    // a deleted device is no longer the provider's: the request never reaches the relay
    const res = await requestOnB(deviceId, { op: "ping" });
    expect(res.ok === false && res.error).toMatchObject({
      name: "ExtensionPermissionError",
      offline: false,
    });
    expect(await redis.exists(`capk:device-req:${deviceId}`)).toBe(0);
  });
});
