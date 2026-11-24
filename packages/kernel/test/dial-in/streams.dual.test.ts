import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDualReplicaHarness,
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  type Harness,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { deviceHolderAddrKey, deviceLeaseKey } from "../../src/dial-in/keys.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import { enableExtensions, PW, waitFor } from "../helpers/runs.js";

/**
 * Dial-in streams across replicas (browser use spec §6.1, §6.2): only the gateway replica holding
 * the machine's socket opens a stream (frames never go through Redis); every other replica finds
 * the holder's internal address under `capk:device-holder-addr:<deviceId>`. Replica A (index 0)
 * runs only the gateway role; replica B (index 1) runs api, worker and gateway. Neither sets
 * `gateway.internalUrl`, so the address is the default `http://<hostname>:<port>`.
 */

const PLUGIN = "fake-dial-in";
const HELLO = { revision: "r1", outsideSandbox: false };

let h: Harness;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let extensionsDir: string;
let cookie = "";
let orgId: string;
const open: FakeDialInMachine[] = [];

type Json = Record<string, unknown>;

/** A call to `replica` with the owner's session. */
async function callTo(replica: 0 | 1, method: string, path: string, body?: unknown) {
  const res = await h.requestTo(replica, path, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(cookie !== "" && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: (text === "" ? {} : JSON.parse(text)) as Json,
  };
}

beforeAll(async () => {
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  extensionsDir = await mkdtemp(join(tmpdir(), "cap-dial-in-streams-"));
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    bootstrap: { dir: bootstrap.dir, manifest: bootstrap.manifest },
    roles: [["gateway"], ["api", "worker", "gateway"]],
    config: {
      auth: { cookieSecure: false },
      extensionHost: { dir: extensionsDir },
      http: { publicUrl: "https://cap.example" },
      devices: { maxPersonal: 50 },
    },
  });
  raw = createDb(h.dbUrl, 2);
  redis = new Redis(h.redisUrl);
  await accountsFor(kernelDb(raw)).createLocal({ login: "owner", password: PW, displayName: "O" });
  const login = await callTo(1, "POST", "/api/v1/auth/login", { login: "owner", password: PW });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const org = await callTo(1, "POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  orgId = (org.json.org as { id: string }).id;
  await enableExtensions(raw, orgId, PLUGIN);
});

afterAll(async () => {
  for (const m of open.splice(0)) await m.close();
  await raw?.destroy();
  redis?.disconnect();
  await h?.stop();
  await bootstrap?.cleanup();
  if (extensionsDir) await rm(extensionsDir, { recursive: true, force: true });
});

/** Signs a fake machine in on replica B into a new device of the fixture provider. */
async function signIn() {
  const keys = await redis.keys("throttler:*");
  if (keys.length > 0) await redis.del(...keys);
  const a = await callTo(1, "POST", "/api/v1/device/authorize", {
    name: "box",
    os: "linux",
    arch: "x64",
    programVersion: "0.0.0-fake",
    protocol: FAKE_DIAL_IN_PROTOCOL,
  });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const c = await callTo(1, "POST", "/api/v1/device/confirm", {
    userCode: a.json.userCode,
    orgId,
    provider: PLUGIN,
    name: `Box ${randomUUID().slice(0, 8)}`,
  });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await callTo(1, "POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return t.json as { credential: string; deviceId: string };
}

const wsUrl = (replica: 0 | 1) => `ws://127.0.0.1:${h.replicas[replica].port}/device/connect`;
const addressOf = (replica: 0 | 1) => `http://${hostname()}:${h.replicas[replica].port}`;

/** `ctx.dialIn.openStream` made by the fixture on `replica`, echoing one message. */
async function streamOn(replica: 0 | 1, deviceId: string) {
  const res = await callTo(replica, "POST", `/plugins/${PLUGIN}/stream`, {
    deviceId,
    body: { target: "echo" },
    message: "hi",
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

describe("dial-in streams across replicas (dual replica)", () => {
  it("the replica that does not hold the machine reports the holder's address", async () => {
    const { credential, deviceId } = await signIn();
    const machine = await FakeDialInMachine.connect({ url: wsUrl(0), credential, hello: HELLO });
    open.push(machine);
    machine.onStream((_o, s) => s.onMessage((m) => void s.send(m)));
    await waitFor(() => redis.get(deviceLeaseKey(deviceId)), 10_000, "lease held");
    const key = deviceHolderAddrKey(deviceId);
    await waitFor(async () => (await redis.get(key)) === addressOf(0), 10_000, "A's address");
    expect(await redis.pttl(key)).toBeGreaterThan(0);

    // B does not hold the socket: it refuses and the address names A
    expect(await streamOn(1, deviceId)).toMatchObject({
      ok: false,
      error: { code: "device.stream_elsewhere" },
    });
    // A holds it: the stream opens there and echoes
    expect(await streamOn(0, deviceId)).toEqual({ ok: true, echo: "hi" });

    // a reconnect to B moves the holder, and its address with it
    const second = await FakeDialInMachine.connect({ url: wsUrl(1), credential, hello: HELLO });
    open.push(second);
    second.onStream((_o, s) => s.onMessage((m) => void s.send(m)));
    await machine.closed;
    await waitFor(async () => (await redis.get(key)) === addressOf(1), 10_000, "B's address");
    expect(await streamOn(1, deviceId)).toEqual({ ok: true, echo: "hi" });
    expect(await streamOn(0, deviceId)).toMatchObject({
      ok: false,
      error: { code: "device.stream_elsewhere" },
    });
  });
});
