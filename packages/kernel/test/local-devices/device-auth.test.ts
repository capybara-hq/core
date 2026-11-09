import { randomUUID } from "node:crypto";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { DeviceView } from "../../src/devices/devices.service.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import {
  DeviceAuthService,
  deviceAuthKey,
  deviceUserKey,
  USER_CODE_ALPHABET,
} from "../../src/local-devices/device-auth.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { TestHolder } from "./test-holder.js";

/**
 * Device authorization (environments spec §6.2, §13.2-13.3): the RFC 8628 shape, from
 * `capybara-device login` to a per-machine credential that only the device connection accepts.
 */

const PUBLIC_URL = "https://cap.example.com";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], http: { port: 0, publicUrl: `${PUBLIC_URL}/` } },
    ),
  );
  machines = k.app.get(MachinesService);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
}, 180_000);

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** Every test starts with fresh rate limits (they are per address and per person). */
async function clearThrottlers(): Promise<void> {
  const keys = await redis.keys("throttler:*");
  if (keys.length > 0) await redis.del(...keys);
}
beforeEach(clearThrottlers);
afterEach(() => {
  vi.restoreAllMocks();
});

type Transition = (hash: string, from: string, to: string, grant?: string) => Promise<boolean>;

/** Replaces the claimed → approved step of the service (the post-commit parking) with `park`. */
function interceptParking(park: (original: Transition, hash: string) => Promise<boolean>): void {
  const svc = k.app.get(DeviceAuthService) as unknown as { transition: Transition };
  const original = svc.transition.bind(svc);
  vi.spyOn(svc, "transition").mockImplementation((hash, from, to, grant) =>
    to === "approved" ? park(original, hash) : original(hash, from, to, grant),
  );
}

const machineRows = (accountId: string) =>
  db
    .selectFrom("device_machines")
    .select(["id", "device_id", "revoked_at"])
    .where("account_id", "=", accountId)
    .execute();

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const MACHINE = { name: "grant-mbp", os: "darwin", arch: "arm64", programVersion: "0.1.0" };

interface Authorized {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

/** The program's public calls: no credentials, the CSRF header the CLI sends. */
function publicPost(url: string, payload: unknown) {
  return k.http.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>,
    headers: { "x-capybara-csrf": "1" },
  });
}

async function authorize(machine: Record<string, unknown> = MACHINE): Promise<Authorized> {
  const res = await publicPost("/api/v1/device/authorize", machine);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Authorized;
}

const token = (deviceCode: string) => publicPost("/api/v1/device/token", { deviceCode });

/** A new member of the org with a session. */
async function member(): Promise<{ id: string; req: Req }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

async function confirm(
  req: Req,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json(): unknown }> {
  return req({ method: "POST", url: "/api/v1/device/confirm", payload: { orgId, ...body } });
}

interface Granted {
  credential: string;
  orgId: string;
  deviceId: string;
  connectUrl: string;
  reconnectGraceSeconds: number;
  maxFrameBytes: number;
}

/** Authorize, confirm into a new device named `name`, take the credential. */
async function login(req: Req, name: string): Promise<Granted> {
  const a = await authorize();
  const c = await confirm(req, { userCode: a.userCode, name });
  expect(c.statusCode, c.body).toBe(200);
  const t = await token(a.deviceCode);
  expect(t.statusCode, t.body).toBe(200);
  return t.json() as Granted;
}

async function envView(req: Req, id: string): Promise<DeviceView> {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { device: DeviceView }).device;
}

const auditActions = async (target: string) =>
  (
    await db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", target)
      .orderBy("id")
      .execute()
  ).map((a) => a.action);

describe("device authorization", () => {
  it("user code alphabet and format", async () => {
    expect(USER_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
    for (let i = 0; i < 5; i++) {
      const a = await authorize();
      expect(a.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(a.deviceCode).toMatch(/^cap_dvc_[A-Za-z0-9_-]{43}$/);
      expect(a).toMatchObject({
        verificationUri: `${PUBLIC_URL}/devices/link`,
        verificationUriComplete: `${PUBLIC_URL}/devices/link?code=${a.userCode}`,
        interval: 5,
        expiresIn: 600,
      });
      // Redis holds only a hash of the device code, both keys with the code's TTL
      expect(await redis.exists(deviceAuthKey(a.deviceCode))).toBe(1);
      const ttl = await redis.ttl(deviceUserKey(a.userCode));
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
      expect(await redis.ttl(deviceAuthKey(a.deviceCode))).toBeGreaterThan(590);
    }
  });

  it("authorize validates the machine and needs the CSRF header", async () => {
    for (const bad of [
      { ...MACHINE, name: "" },
      { ...MACHINE, name: "x".repeat(65) },
      { ...MACHINE, os: "win32" },
      { ...MACHINE, extra: 1 },
    ]) {
      const res = await publicPost("/api/v1/device/authorize", bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const noCsrf = await k.http.inject({
      method: "POST",
      url: "/api/v1/device/authorize",
      payload: MACHINE,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errCode(noCsrf)).toBe("auth.csrf");
  });

  it("authorize is limited to 20 per address in 15 minutes; user code tries to 10 per person", async () => {
    for (let i = 0; i < 20; i++) await authorize();
    const over = await publicPost("/api/v1/device/authorize", MACHINE);
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("auth.rate_limited");
    await clearThrottlers();

    const m = await member();
    for (let i = 0; i < 10; i++) {
      const res = await m.req({ method: "GET", url: "/api/v1/device/pending/BCDF-GHJK" });
      expect(errCode(res)).toBe("device_sign_in.code_invalid");
    }
    const a = await authorize();
    const limited = await m.req({ method: "GET", url: `/api/v1/device/pending/${a.userCode}` });
    expect(limited.statusCode).toBe(429);
    const denied = await m.req({
      method: "POST",
      url: "/api/v1/device/deny",
      payload: { userCode: a.userCode },
    });
    expect(denied.statusCode).toBe(429);
    // another person is not affected, and a success gives the try back
    const other = await member();
    for (let i = 0; i < 20; i++) {
      const ok = await other.req({ method: "GET", url: `/api/v1/device/pending/${a.userCode}` });
      expect(ok.statusCode).toBe(200);
    }
  });

  it("full flow: authorize → pending → confirm with a new name → token returns a working credential once", async () => {
    const m = await member();
    const a = await authorize();

    // the web page shows the machine (the code accepted without the dash, lower case too)
    const raw = a.userCode.replace("-", "").toLowerCase();
    const pending = await m.req({ method: "GET", url: `/api/v1/device/pending/${raw}` });
    expect(pending.statusCode, pending.body).toBe(200);
    const p = pending.json() as { machine: unknown; expiresAt: string };
    expect(p.machine).toEqual(MACHINE);
    expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now() + 590_000);

    const c = await confirm(m.req, { userCode: a.userCode, name: "Laptop" });
    expect(c.statusCode, c.body).toBe(200);
    const { deviceId } = c.json() as { deviceId: string };

    const t = await token(a.deviceCode);
    expect(t.statusCode, t.body).toBe(200);
    const g = t.json() as Granted;
    expect(g).toEqual({
      credential: expect.stringMatching(/^cap_dev_[A-Za-z0-9_-]{43}$/),
      orgId,
      deviceId,
      connectUrl: "wss://cap.example.com/device/connect",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 16 * 1024 * 1024,
    });

    // the credential authenticates the machine; it is never an /api credential
    const who = await machines.authenticate(g.credential);
    expect(who).toMatchObject({ orgId, deviceId, accountId: m.id });
    const asApi = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${g.credential}` },
    });
    expect(asApi.statusCode).toBe(401);
    // only its hash is stored
    const row = await db
      .selectFrom("device_machines")
      .selectAll()
      .where("device_id", "=", deviceId)
      .executeTakeFirstOrThrow();
    expect(row.credential_hash).not.toContain(g.credential);
    expect(row).toMatchObject({
      org_id: orgId,
      account_id: m.id,
      name: "grant-mbp",
      os: "darwin",
      arch: "arm64",
      program_version: "0.1.0",
      revoked_at: null,
    });

    // once: the code is gone afterwards
    const again = await token(a.deviceCode);
    expect(again.statusCode).toBe(400);
    expect(errCode(again)).toBe("device_sign_in.expired");
    expect(await redis.exists(deviceAuthKey(a.deviceCode))).toBe(0);
    expect(await redis.exists(deviceUserKey(a.userCode))).toBe(0);
    const gone = await m.req({ method: "GET", url: `/api/v1/device/pending/${a.userCode}` });
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("device_sign_in.code_invalid");

    // the device is a device one with its machine, offline until the program connects
    const v = await envView(m.req, deviceId);
    expect(v).toMatchObject({
      name: "Laptop",
      source: "local",
      provider: "@local",
      online: false,
      machine: { name: "grant-mbp", os: "darwin", programVersion: "0.1.0" },
    });
    expect(await auditActions(deviceId)).toEqual(["device.created", "device.machine_connected"]);
  });

  it("token before confirm is authorization_pending", async () => {
    const a = await authorize();
    const t = await token(a.deviceCode);
    expect(t.statusCode).toBe(400);
    expect(errCode(t)).toBe("device_sign_in.authorization_pending");
  });

  it("polling twice within 5 s is slow_down and the interval grows to 10", async () => {
    const a = await authorize();
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.authorization_pending");
    const fast = await token(a.deviceCode);
    expect(fast.statusCode).toBe(400);
    expect(errCode(fast)).toBe("device_sign_in.slow_down");
    expect((fast.json() as { error: { details?: unknown[] } }).error.details).toEqual([
      { interval: 10 },
    ]);
    // 6 s later is still too fast for the grown interval
    const key = deviceAuthKey(a.deviceCode);
    await redis.hset(key, "lastPollAt", String(Date.now() - 6_000));
    const still = await token(a.deviceCode);
    expect(errCode(still)).toBe("device_sign_in.slow_down");
    expect((still.json() as { error: { details?: unknown[] } }).error.details).toEqual([
      { interval: 15 },
    ]);
    await redis.hset(key, "lastPollAt", String(Date.now() - 16_000));
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.authorization_pending");
  });

  it("deny ends with device_sign_in.denied", async () => {
    const m = await member();
    const a = await authorize();
    const d = await m.req({
      method: "POST",
      url: "/api/v1/device/deny",
      payload: { userCode: a.userCode },
    });
    expect(d.statusCode, d.body).toBe(204);
    const t = await token(a.deviceCode);
    expect(t.statusCode).toBe(400);
    expect(errCode(t)).toBe("device_sign_in.denied");
    // a denied code cannot be confirmed afterwards
    const c = await confirm(m.req, { userCode: a.userCode, name: "Nope" });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("device_sign_in.code_invalid");
  });

  it("unknown device codes are expired; unknown user codes invalid", async () => {
    const t = await token(`cap_dvc_${"A".repeat(43)}`);
    expect(errCode(t)).toBe("device_sign_in.expired");
    const bad = await token("nope");
    expect(bad.statusCode).toBe(400);
    const m = await member();
    for (const code of ["BCDF-GHJK", "AAAA-AAAA", "short"]) {
      const res = await m.req({ method: "GET", url: `/api/v1/device/pending/${code}` });
      expect(res.statusCode, code).toBe(404);
      expect(errCode(res)).toBe("device_sign_in.code_invalid");
    }
  });

  it("the person-side routes need a web session and org membership", async () => {
    const a = await authorize();
    const anon = await k.http.inject({
      method: "GET",
      url: `/api/v1/device/pending/${a.userCode}`,
    });
    expect(anon.statusCode).toBe(401);
    // not a member of the org → org.not_found, and the code stays usable
    const outsider = `out-${randomUUID().slice(0, 8)}`;
    await accountsFor(db).createLocal({ login: outsider, password: PW, displayName: "X" });
    const o = await session(k, outsider);
    const c = await confirm(o, { userCode: a.userCode, name: "Mine" });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("org.not_found");
    // exactly one of deviceId and name
    const m = await member();
    const both = await confirm(m.req, {
      userCode: a.userCode,
      name: "X",
      deviceId: randomUUID(),
    });
    expect(both.statusCode).toBe(400);
    const neither = await confirm(m.req, { userCode: a.userCode });
    expect(neither.statusCode).toBe(400);
    expect((await confirm(m.req, { userCode: a.userCode, name: "Mine" })).statusCode).toBe(200);
  });

  it("confirm into another person's device is device.not_found", async () => {
    const alice = await member();
    const bob = await member();
    const g = await login(alice.req, "Alice box");
    const a = await authorize();
    const c = await confirm(bob.req, { userCode: a.userCode, deviceId: g.deviceId });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("device.not_found");
    // the failed confirm leaves the code pending for another try
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.authorization_pending");
    // and alice's machine is untouched
    expect(await machines.authenticate(g.credential)).not.toBeNull();
    // a cloud device of one's own is refused too
    const cloud = await db
      .insertInto("devices")
      .values({
        id: randomUUID(),
        org_id: orgId,
        owner_kind: "personal",
        owner_account_id: bob.id,
        name: "Cloud",
        source: "cloud",
        provider: "sandbox-fake",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const c2 = await confirm(bob.req, { userCode: a.userCode, deviceId: cloud.id });
    expect(errCode(c2)).toBe("device.not_found");
  });

  it("two concurrent confirms on one code issue exactly one machine", async () => {
    const m = await member();
    const a = await authorize();
    const [x, y] = await Promise.all([
      confirm(m.req, { userCode: a.userCode, name: "Race A" }),
      confirm(m.req, { userCode: a.userCode, name: "Race B" }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 404]);
    expect(errCode(x.statusCode === 404 ? x : y)).toBe("device_sign_in.code_invalid");
    expect(await machineRows(m.id)).toHaveLength(1);
    expect((await token(a.deviceCode)).statusCode).toBe(200);
  });

  it("concurrent confirms with the same new name both succeed (one retries with a free name)", async () => {
    const m = await member();
    const [a, b] = await Promise.all([authorize(), authorize()]);
    const res = await Promise.all([
      confirm(m.req, { userCode: a.userCode, name: "Twin" }),
      confirm(m.req, { userCode: b.userCode, name: "Twin" }),
    ]);
    for (const r of res) expect(r.statusCode, r.body).toBe(200);
    const names = await Promise.all(
      res.map(
        async (r) => (await envView(m.req, (r.json() as { deviceId: string }).deviceId)).name,
      ),
    );
    expect(names.sort()).toEqual(["Twin", "Twin 2"]);
  });

  it("a confirm that cannot park the credential answers 503 and revokes the machine", async () => {
    const m = await member();
    const a = await authorize();
    interceptParking(async () => {
      throw new Error("injected Redis failure");
    });
    const c = await confirm(m.req, { userCode: a.userCode, name: "Unlucky" });
    expect(c.statusCode).toBe(503);
    expect(errCode(c)).toBe("device_sign_in.unavailable");
    vi.restoreAllMocks();
    const rows = await machineRows(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(await auditActions(rows[0]?.device_id as string)).toEqual([
      "device.created",
      "device.machine_connected",
      "device.machine_revoked",
    ]);
    // the program stops polling at once
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.expired");
  });

  it("a code expiring mid-confirm answers device_sign_in.expired and leaves no usable machine", async () => {
    const m = await member();
    const a = await authorize();
    interceptParking(async (original, hash) => {
      await redis.del(`capk:device-auth:${hash}`);
      return original(hash, "claimed", "approved", "{}");
    });
    const c = await confirm(m.req, { userCode: a.userCode, name: "Late" });
    expect(c.statusCode).toBe(400);
    expect(errCode(c)).toBe("device_sign_in.expired");
    const rows = await machineRows(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(await machines.activeFor(rows[0]?.device_id as string)).toBeNull();
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.expired");
  });

  it("token polls are limited to 600 per address in 15 minutes", async () => {
    for (let i = 0; i < 600; i++) await token("nope");
    const over = await token("nope");
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("auth.rate_limited");
  });

  it("a new name that is taken gets a free one", async () => {
    const m = await member();
    const first = await login(m.req, "Box");
    const second = await login(m.req, "box");
    expect((await envView(m.req, first.deviceId)).name).toBe("Box");
    expect((await envView(m.req, second.deviceId)).name).toBe("box 2");
  });

  it("a new login replaces the machine and the old credential stops authenticating", async () => {
    const m = await member();
    const first = await login(m.req, "Desk");
    const holder = new TestHolder(redis, k.app.get(KERNEL_BUS), first.deviceId);
    await holder.connect();
    const old = await machines.activeFor(first.deviceId);
    expect(old).not.toBeNull();
    const revoked: unknown[] = [];
    const unsub = await k.app
      .get(KERNEL_BUS)
      .subscribe(`device.revoked.${first.deviceId}`, (p: unknown) => {
        revoked.push(p);
      });
    try {
      const a = await authorize({ ...MACHINE, name: "desk-2" });
      const c = await confirm(m.req, {
        userCode: a.userCode,
        deviceId: first.deviceId,
      });
      expect(c.statusCode, c.body).toBe(200);
      expect((c.json() as { deviceId: string }).deviceId).toBe(first.deviceId);
      const t = await token(a.deviceCode);
      expect(t.statusCode, t.body).toBe(200);
      const second = t.json() as Granted;
      expect(second.deviceId).toBe(first.deviceId);
      expect(await machines.authenticate(first.credential)).toBeNull();
      expect(await machines.authenticate(second.credential)).toMatchObject({
        deviceId: first.deviceId,
      });
      // the old machine's connection is closed; no stop frame is queued (the replacement
      // machine connecting next would drain it)
      await waitFor(async () => revoked.length > 0);
      expect(holder.frames.filter((f) => f.type === "req" && f.op === "stop")).toEqual([]);
      expect(revoked[0]).toEqual({ machineId: old?.id });
      expect((await machines.activeFor(first.deviceId))?.name).toBe("desk-2");
    } finally {
      await unsub();
      await holder.disconnect();
    }
  });

  it("revoke audits and the credential no longer authenticates", async () => {
    const m = await member();
    const g = await login(m.req, "Revokable");
    const url = `/api/v1/orgs/${orgId}/devices/${g.deviceId}/machine`;
    // someone else cannot revoke it
    const other = await member();
    const denied = await other.req({ method: "DELETE", url });
    expect(denied.statusCode).toBe(404);
    expect(errCode(denied)).toBe("device.not_found");
    expect(await machines.authenticate(g.credential)).not.toBeNull();

    const holder = new TestHolder(redis, k.app.get(KERNEL_BUS), g.deviceId);
    await holder.connect();
    try {
      const res = await m.req({ method: "DELETE", url });
      expect(res.statusCode, res.body).toBe(204);
      const stop = (await holder.next((f) => f.type === "req" && f.op === "stop")) as KernelReq;
      expect(stop.args).toEqual({ reason: "revoked" });
    } finally {
      await holder.disconnect();
    }
    expect(await machines.authenticate(g.credential)).toBeNull();
    expect(await auditActions(g.deviceId)).toContain("device.machine_revoked");
    expect((await envView(m.req, g.deviceId)).machine).toBeNull();
    // the device stays
    expect((await envView(m.req, g.deviceId)).source).toBe("local");
  });

  it("deleting a local device revokes its machine", async () => {
    const m = await member();
    const g = await login(m.req, "Doomed");
    const holder = new TestHolder(redis, k.app.get(KERNEL_BUS), g.deviceId);
    await holder.connect();
    try {
      const del = await m.req({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/devices/${g.deviceId}`,
      });
      expect(del.statusCode, del.body).toBe(202);
      expect(await machines.authenticate(g.credential)).toBeNull();
      const row = await db
        .selectFrom("device_machines")
        .select("revoked_at")
        .where("device_id", "=", g.deviceId)
        .executeTakeFirstOrThrow();
      expect(row.revoked_at).not.toBeNull();
      const stop = (await holder.next((f) => f.type === "req" && f.op === "stop")) as KernelReq;
      expect(stop.args).toEqual({ reason: "deleted" });
    } finally {
      await holder.disconnect();
    }
  });
});
