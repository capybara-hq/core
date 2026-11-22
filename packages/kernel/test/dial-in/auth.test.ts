import { randomUUID } from "node:crypto";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import {
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  signInFakeMachine,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { DeviceView } from "../../src/devices/devices.service.js";
import {
  DialInAuthService,
  deviceAuthKey,
  deviceUserKey,
  USER_CODE_ALPHABET,
} from "../../src/dial-in/auth.service.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { TestHolder } from "../helpers/test-holder.js";

/**
 * Device authorization (environments spec §6.2, §13.2-13.3; device provider spec §5): the
 * RFC 8628 shape, from `capybara-device login` to a per-machine credential that only the device
 * connection accepts. The person chooses the dial-in provider that takes the machine: one on in the org that
 * speaks the program's protocol (`fake-dial-in`, and `fake-dial-in-b` speaking another one).
 */

/** The second dial-in fixture provider: on in the org, speaking another protocol. */
const OTHER_DIAL_IN = "fake-dial-in-b";
const OTHER_PROTOCOL = "fake-other/1";
/**
 * A third fixture provider, loaded but on in no org, declaring the SDK's `capybara-device`
 * protocol: it stands in for device-local in `GET /api/v1/meta` (the last describe unloads it).
 */
const LOCAL_DIAL_IN = "fake-local";

const PUBLIC_URL = "https://cap.example.com";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let machines: DialInMachines;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  // optional preinstalls: loaded on the deployment, on only in the orgs that switch them on
  bootstrap = await bootstrapFixture([
    { bytes: await fakeDialInPkg(), required: false },
    {
      bytes: await fakeDialInPkg({ name: OTHER_DIAL_IN, protocol: OTHER_PROTOCOL }),
      required: false,
    },
    {
      bytes: await fakeDialInPkg({ name: LOCAL_DIAL_IN, protocol: DEVICE_DIAL_IN_PROTOCOL }),
      required: false,
    },
  ]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        http: { port: 0, publicUrl: `${PUBLIC_URL}/` },
        devices: { maxPersonal: 50 },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  machines = k.app.get(DialInMachines);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enableExtensions(raw, orgId, "fake-dial-in", OTHER_DIAL_IN);
  await waitFor(async () => k.app.get(DeviceProviders).forDevice(OTHER_DIAL_IN) ?? null);
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  await waitFor(async () => k.app.get(DeviceProviders).forDevice(LOCAL_DIAL_IN) ?? null);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
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
  const svc = k.app.get(DialInAuthService) as unknown as { transition: Transition };
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

const MACHINE = {
  name: "grant-mbp",
  os: "darwin",
  arch: "arm64",
  programVersion: "0.1.0",
  protocol: FAKE_DIAL_IN_PROTOCOL,
};

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
  return req({
    method: "POST",
    url: "/api/v1/device/confirm",
    payload: { orgId, provider: "fake-dial-in", ...body },
  });
}

interface Granted {
  credential: string;
  orgId: string;
  deviceId: string;
  connectUrl: string;
  reconnectGraceSeconds: number;
  maxFrameBytes: number;
  outsideSandbox: "allowed" | "off";
  deviceName: string | null;
  orgName: string;
}

/** Authorize, confirm into a new device named `name`, take the credential. */
/**
 * Signs a machine in to a new device named `name` of `fake-dial-in`, or of {@link OTHER_DIAL_IN}
 * (`other`: its protocol).
 */
async function login(req: Req, name: string, other = false): Promise<Granted> {
  const a = await authorize(other ? { ...MACHINE, protocol: OTHER_PROTOCOL } : MACHINE);
  const c = await confirm(req, {
    userCode: a.userCode,
    name,
    ...(other && { provider: OTHER_DIAL_IN }),
  });
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
      { ...MACHINE, protocol: "Capybara/5" },
      { ...MACHINE, protocol: "capybara-device" },
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
      outsideSandbox: "allowed",
      deviceName: "Laptop",
      orgName: expect.any(String),
    });
    const org = await db
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(g.orgName).toBe(org.name);

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
      dialIn: true,
      provider: "fake-dial-in",
      online: false,
      machine: { name: "grant-mbp", os: "darwin", programVersion: "0.1.0" },
    });
    expect(await auditActions(deviceId)).toEqual(["device.created", "device.machine_connected"]);
  });

  it("the token says the organization does not allow Full access (login's line)", async () => {
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ outsideSandbox: "off" }) })
      .where("id", "=", orgId)
      .execute();
    const m = await member();
    const g = await login(m.req, "Mode line");
    expect(g.outsideSandbox).toBe("off");
  });

  it("a device without a name gives deviceName null in the token", async () => {
    const m = await member();
    const a = await authorize();
    const c = await confirm(m.req, { userCode: a.userCode, name: "Nameless" });
    expect(c.statusCode, c.body).toBe(200);
    const { deviceId } = c.json() as { deviceId: string };
    await db.updateTable("devices").set({ name: null }).where("id", "=", deviceId).execute();
    const t = await token(a.deviceCode);
    expect(t.statusCode, t.body).toBe(200);
    const g = t.json() as Granted;
    expect(g.deviceId).toBe(deviceId);
    expect(g.deviceName).toBeNull();
    expect(g.orgName).toEqual(expect.any(String));
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
        provider: "device-fake",
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
      expect(holder.frames.filter((f) => f.type === "stop")).toEqual([]);
      expect(revoked[0]).toEqual({ machineId: old?.id, reason: "replaced" });
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
      const stop = await holder.next((f) => f.type === "stop");
      expect(stop).toEqual({ type: "stop", reason: "stop", machineId: expect.any(String) });
    } finally {
      await holder.disconnect();
    }
    expect(await machines.authenticate(g.credential)).toBeNull();
    expect(await auditActions(g.deviceId)).toContain("device.machine_revoked");
    expect((await envView(m.req, g.deviceId)).machine).toBeNull();
    // the device stays
    expect((await envView(m.req, g.deviceId)).dialIn).toBe(true);
  });

  it("deleting a dial-in device revokes its machine", async () => {
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
      const stop = await holder.next((f) => f.type === "stop");
      expect(stop).toEqual({ type: "stop", reason: "stop", machineId: expect.any(String) });
    } finally {
      await holder.disconnect();
    }
  });
});

/** The `Cookie` header of a fresh web session of `login` (what `signInFakeMachine` takes). */
async function sessionCookie(login: string): Promise<string> {
  const res = await k.http.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-capybara-csrf": "1" },
    payload: { login, password: PW },
  });
  expect(res.statusCode, res.body).toBe(200);
  const set = res.headers["set-cookie"];
  return (Array.isArray(set) ? set : [String(set)]).map((c) => c.split(";")[0]).join("; ");
}

/** A new member of the org with a session and its cookie. */
async function memberWithCookie(): Promise<{ id: string; req: Req; cookie: string }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login), cookie: await sessionCookie(login) };
}

const HELLO = { revision: "r1", outsideSandbox: false };
const connectUrl = () => `ws://127.0.0.1:${k.port}/device/connect`;

async function providers(req: Req, query: { orgId: string; userCode: string }) {
  return req({
    method: "GET",
    url: `/api/v1/device/providers?orgId=${query.orgId}&userCode=${query.userCode}`,
  });
}

type Choice = { plugin: string; displayName: { en: string }; devices: { id: string }[] };

describe("the sign-in chooses a dial-in provider", () => {
  it("a fake machine signs in to fake-dial-in end to end and connects", async () => {
    const m = await memberWithCookie();
    const signed = await signInFakeMachine(k, {
      orgId,
      session: m.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "Fake box",
    });
    expect(signed.connectUrl).toBe("wss://cap.example.com/device/connect");
    // confirm creates the device bound to the chosen provider
    const row = await db
      .selectFrom("devices")
      .select(["provider", "owner_account_id", "org_id", "name"])
      .where("id", "=", signed.deviceId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      provider: "fake-dial-in",
      owner_account_id: m.id,
      org_id: orgId,
      name: "Fake box",
    });
    const connected = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", signed.deviceId)
      .where("action", "=", "device.machine_connected")
      .executeTakeFirstOrThrow();
    expect(connected.detail).toMatchObject({
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
    });
    // the credential opens the dial-in channel of that provider
    const machine = await FakeDialInMachine.connect({
      url: connectUrl(),
      credential: signed.credential,
      hello: HELLO,
    });
    try {
      expect(machine.connectionId).toEqual(expect.any(String));
    } finally {
      await machine.close();
    }
  });

  it("authorize without protocol answers 400", async () => {
    const { protocol: _, ...noProtocol } = MACHINE;
    const res = await publicPost("/api/v1/device/authorize", noProtocol);
    expect(res.statusCode, res.body).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("lists only providers on in the org that declare the machine's protocol", async () => {
    const m = await memberWithCookie();
    const fake = await authorize({ ...MACHINE, protocol: FAKE_DIAL_IN_PROTOCOL });
    const listed = await providers(m.req, { orgId, userCode: fake.userCode });
    expect(listed.statusCode, listed.body).toBe(200);
    const choices = (listed.json() as { providers: Choice[] }).providers;
    expect(choices).toEqual([
      {
        plugin: "fake-dial-in",
        displayName: expect.objectContaining({ en: expect.any(String) }),
        devices: [],
      },
    ]);

    // the person's own devices of that provider are offered; another person's never
    const mine = await signInFakeMachine(k, {
      orgId,
      session: m.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "Mine",
    });
    const other = await memberWithCookie();
    await signInFakeMachine(k, {
      orgId,
      session: other.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "Theirs",
    });
    const otherBox = await login(m.req, "Other box", true);
    const again = (
      (await providers(m.req, { orgId, userCode: fake.userCode })).json() as {
        providers: Choice[];
      }
    ).providers;
    expect(again).toEqual([
      {
        plugin: "fake-dial-in",
        displayName: expect.any(Object),
        devices: [{ id: mine.deviceId, name: "Mine" }],
      },
    ]);

    // the other protocol: only the provider speaking it, with the person's devices of it
    const b = await authorize({ ...MACHINE, protocol: OTHER_PROTOCOL });
    const forB = (
      (await providers(m.req, { orgId, userCode: b.userCode })).json() as { providers: Choice[] }
    ).providers;
    expect(forB).toEqual([
      {
        plugin: OTHER_DIAL_IN,
        displayName: expect.any(Object),
        devices: [{ id: otherBox.deviceId, name: "Other box" }],
      },
    ]);
    // a protocol nobody speaks: none
    const none = await authorize({ ...MACHINE, protocol: "nobody/1" });
    expect(
      (
        (await providers(m.req, { orgId, userCode: none.userCode })).json() as {
          providers: Choice[];
        }
      ).providers,
    ).toEqual([]);

    // an org where fake-dial-in is off lists nothing for it
    const org2 = await createOrg(owner, "Beta");
    const off = await providers(owner, { orgId: org2, userCode: fake.userCode });
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as { providers: Choice[] }).providers).toEqual([]);
    // not a member of the org → org.not_found; an unknown code → code_invalid
    const outsider = await providers(m.req, { orgId: org2, userCode: fake.userCode });
    expect(outsider.statusCode).toBe(404);
    expect(errCode(outsider)).toBe("org.not_found");
    const unknown = await providers(m.req, { orgId, userCode: "BCDF-GHJK" });
    expect(errCode(unknown)).toBe("device_sign_in.code_invalid");
    // listing does not use the code up
    expect(errCode(await token(fake.deviceCode))).toBe("device_sign_in.authorization_pending");
  });

  it("a person in two orgs sees, per org, that org's providers and their own devices there", async () => {
    const m = await memberWithCookie();
    // a second org where m is a member too and only fake-dial-in is on
    const org2 = await createOrg(owner, "Two orgs");
    await testMembers(db).add(org2, m.id, "member", ownerId);
    await enableExtensions(raw, org2, "fake-dial-in");
    const inA = await signInFakeMachine(k, {
      orgId,
      session: m.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "In A",
    });
    const inB = await signInFakeMachine(k, {
      orgId: org2,
      session: m.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "In B",
    });
    const otherInA = await login(m.req, "Other in A", true);

    const fake = await authorize({ ...MACHINE, protocol: FAKE_DIAL_IN_PROTOCOL });
    const list = async (org: string, userCode: string) => {
      const res = await providers(m.req, { orgId: org, userCode });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { providers: Choice[] }).providers;
    };
    // the same code: each org lists only the person's devices in that org
    expect(await list(orgId, fake.userCode)).toEqual([
      {
        plugin: "fake-dial-in",
        displayName: expect.any(Object),
        devices: [{ id: inA.deviceId, name: "In A" }],
      },
    ]);
    expect(await list(org2, fake.userCode)).toEqual([
      {
        plugin: "fake-dial-in",
        displayName: expect.any(Object),
        devices: [{ id: inB.deviceId, name: "In B" }],
      },
    ]);
    // the other provider is on only in the first org: the second lists nothing for its protocol
    const b = await authorize({ ...MACHINE, protocol: OTHER_PROTOCOL });
    expect(await list(orgId, b.userCode)).toEqual([
      {
        plugin: OTHER_DIAL_IN,
        displayName: expect.any(Object),
        devices: [{ id: otherInA.deviceId, name: "Other in A" }],
      },
    ]);
    expect(await list(org2, b.userCode)).toEqual([]);
    // confirming in the second org into the first org's device is refused
    const cross = await m.req({
      method: "POST",
      url: "/api/v1/device/confirm",
      payload: {
        userCode: fake.userCode,
        orgId: org2,
        provider: "fake-dial-in",
        deviceId: inA.deviceId,
      },
    });
    expect(cross.statusCode, cross.body).toBe(404);
    expect(errCode(cross)).toBe("device.not_found");
  });

  it("confirm with a provider off in the org answers device.provider_unavailable", async () => {
    const m = await member();
    const a = await authorize({ ...MACHINE, protocol: FAKE_DIAL_IN_PROTOCOL });
    const org2 = await createOrg(owner, "Gamma");
    const off = await owner({
      method: "POST",
      url: "/api/v1/device/confirm",
      payload: { userCode: a.userCode, orgId: org2, provider: "fake-dial-in", name: "Off" },
    });
    expect(off.statusCode, off.body).toBe(403);
    expect(errCode(off)).toBe("device.provider_unavailable");
    // a provider speaking another protocol, an unknown one and an in-process name
    for (const provider of [OTHER_DIAL_IN, "no-such-provider", "@in-process"]) {
      const c = await confirm(m.req, { userCode: a.userCode, provider, name: "Wrong" });
      expect(c.statusCode, provider).toBe(403);
      expect(errCode(c), provider).toBe("device.provider_unavailable");
    }
    // nothing was written and the code stays pending for another try
    expect(await machineRows(m.id)).toEqual([]);
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.authorization_pending");
    const ok = await confirm(m.req, { userCode: a.userCode, provider: "fake-dial-in", name: "Ok" });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("an existing device must be the person's own of the chosen provider", async () => {
    const m = await member();
    const local = await login(m.req, "Other only", true);
    const a = await authorize({ ...MACHINE, protocol: FAKE_DIAL_IN_PROTOCOL });
    // the person's own device, but of another provider
    const c = await confirm(m.req, {
      userCode: a.userCode,
      provider: "fake-dial-in",
      deviceId: local.deviceId,
    });
    expect(c.statusCode).toBe(404);
    expect(errCode(c)).toBe("device.not_found");
    expect(await machines.authenticate(local.credential)).not.toBeNull();
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.authorization_pending");
  });

  it("confirm into an existing device of the provider replaces its machine", async () => {
    const m = await memberWithCookie();
    const first = await signInFakeMachine(k, {
      orgId,
      session: m.cookie,
      provider: "fake-dial-in",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      name: "Replaced",
    });
    const old = await FakeDialInMachine.connect({
      url: connectUrl(),
      credential: first.credential,
      hello: HELLO,
    });
    const a = await authorize({ ...MACHINE, name: "fake-2", protocol: FAKE_DIAL_IN_PROTOCOL });
    const c = await confirm(m.req, {
      userCode: a.userCode,
      provider: "fake-dial-in",
      deviceId: first.deviceId,
    });
    expect(c.statusCode, c.body).toBe(200);
    expect((c.json() as { deviceId: string }).deviceId).toBe(first.deviceId);
    // the old credential is revoked and its socket closes as replaced
    expect(await machines.authenticate(first.credential)).toBeNull();
    expect((await old.closed).code).toBe(4002);
    const t = await token(a.deviceCode);
    expect(t.statusCode, t.body).toBe(200);
    const second = t.json() as Granted;
    expect(second.deviceId).toBe(first.deviceId);
    const next = await FakeDialInMachine.connect({
      url: connectUrl(),
      credential: second.credential,
      hello: HELLO,
    });
    await next.close();
    // single use: the code cannot be confirmed or polled again
    expect(errCode(await token(a.deviceCode))).toBe("device_sign_in.expired");
    const reuse = await confirm(m.req, {
      userCode: a.userCode,
      provider: "fake-dial-in",
      deviceId: first.deviceId,
    });
    expect(errCode(reuse)).toBe("device_sign_in.code_invalid");
  });
});

// Last: unloads the capybara-device stand-in.
describe("GET /api/v1/meta local devices", () => {
  it("is on while a capybara-device provider is loaded (in no org), its declared major as the range", async () => {
    const meta = async () => {
      const res = await k.http.inject({ method: "GET", url: "/api/v1/meta" });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        protocols: { device: { min: number; max: number } };
        features: { localDevices: boolean };
      };
    };
    const major = Number(DEVICE_DIAL_IN_PROTOCOL.split("/")[1]);
    const on = await meta();
    expect(on.features.localDevices).toBe(true);
    expect(on.protocols.device).toEqual({ min: major, max: major });
    // fake-dial-in and fake-dial-in-b stay loaded but speak other protocols: no local devices
    await k.app.get(ExtensionHost).unload(LOCAL_DIAL_IN);
    expect((await meta()).features.localDevices).toBe(false);
  });
});
