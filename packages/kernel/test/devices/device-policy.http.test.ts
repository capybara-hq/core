import { randomUUID } from "node:crypto";
import type { DeviceHello, DeviceLocalPolicySummary, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { DeviceView } from "../../src/devices/devices.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
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
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * The device owner changes the machine's policy from the web (network ask-to-allow spec §7, §13
 * Q6; auto mode spec §4.1): `POST /devices/:id/policy` with hosts or `mode: "sandbox"`, owner only,
 * web session only, delivered with the `policy` op to a fake machine on a real WebSocket, and the
 * recent changes on the device view.
 */

const POLICY: DeviceLocalPolicySummary = {
  mode: "auto",
  allowedDomains: ["pypi.org"],
};
const FEATURES: Partial<DeviceHello> = {
  features: ["networkReport", "policyOp", "policyOpId", "mode"],
  policy: POLICY,
};

const DOCKER_MESSAGE =
  "This device runs commands in Docker mode, which cannot limit network access per domain; switch the device to OS mode to allow single domains.";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        devices: { local: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
  );
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const base = () => `/api/v1/orgs/${orgId}/devices`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
const errMessage = (res: { json(): unknown }) =>
  (res.json() as { error?: { message?: string } }).error?.message;

/** A new member with a session, a local device and a signed-in machine (not connected). */
async function owned() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Name ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const d = await txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(orgId, accountId, "Box");
    const issued = await machines.issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
  return { accountId, login, req: await session(k, login), ...d };
}

/** Connects the machine with `hello` and waits until its lease and hello are recorded. */
async function connect(
  d: { deviceId: string; machineId: string; credential: string },
  answer: (req: KernelReq) => Answer,
  hello: Partial<DeviceHello> = FEATURES,
) {
  const machine = new FakeMachine(url, d.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, ...hello });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", d.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return machine;
}

/** A machine that applies `policy` ops the way capybara-device does. */
function applying(start: DeviceLocalPolicySummary): (req: KernelReq) => Answer {
  let now = start;
  return (req) => {
    if (req.op !== "policy") return { ok: true, result: null };
    const a = req.args as { add?: string[]; remove?: string[]; mode?: "sandbox" };
    const domains = new Set(now.allowedDomains);
    for (const h of a.add ?? []) domains.add(h);
    for (const h of a.remove ?? []) domains.delete(h);
    now = {
      ...now,
      allowedDomains: [...domains],
      ...(a.mode !== undefined && { mode: a.mode }),
    };
    return { ok: true, result: { policy: now } };
  };
}

const post = (req: Req, deviceId: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `${base()}/${deviceId}/policy`, payload });

const policyReqs = (m: FakeMachine) =>
  m.frames.filter((f): f is KernelReq => f.type === "req" && f.op === "policy");

const auditsOf = (deviceId: string, action = "device.policy_changed") =>
  db
    .selectFrom("audit_events")
    .select(["actor_account_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "=", action)
    .orderBy("at")
    .orderBy("id")
    .execute();

async function view(req: Req, deviceId: string): Promise<DeviceView> {
  const res = await req({ method: "GET", url: `${base()}/${deviceId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { device: DeviceView }).device;
}

describe("POST /devices/:id/policy", () => {
  it("the owner adds (a wildcard too), removes, and turns sandbox mode on; each change is audited", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY));

    const added = await post(d.req, d.deviceId, { add: ["files.slack.com", "*.npmjs.org"] });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toEqual({
      policy: { ...POLICY, allowedDomains: ["pypi.org", "files.slack.com", "*.npmjs.org"] },
    });
    const [req] = policyReqs(machine);
    expect(req?.args).toEqual({
      add: ["files.slack.com", "*.npmjs.org"],
      opId: expect.any(String),
      // the owner's own change: no approval, so the machine accepts a wildcard
      source: { accountId: d.accountId, accountName: `Name ${d.login}`, via: "web" },
    });

    const removed = await post(d.req, d.deviceId, { remove: ["pypi.org"] });
    expect(removed.statusCode, removed.body).toBe(200);
    const narrowed = await post(d.req, d.deviceId, { mode: "sandbox" });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json()).toEqual({
      policy: { mode: "sandbox", allowedDomains: ["files.slack.com", "*.npmjs.org"] },
    });
    expect(policyReqs(machine).at(-1)?.args).toMatchObject({ mode: "sandbox" });

    expect((await auditsOf(d.deviceId)).map((a) => a.detail)).toEqual([
      expect.objectContaining({ add: ["files.slack.com", "*.npmjs.org"], via: "web" }),
      expect.objectContaining({ remove: ["pypi.org"] }),
    ]);
    expect((await auditsOf(d.deviceId, "device.mode_changed")).map((a) => a.detail)).toEqual([
      expect.objectContaining({ from: "auto", to: "sandbox", via: "web" }),
    ]);

    // the device page lists the recent changes, newest first, with the person's name
    const v = await view(d.req, d.deviceId);
    expect(v.mode.local).toEqual({
      reported: "sandbox",
      allowedDomains: ["files.slack.com", "*.npmjs.org"],
    });
    expect(v.mode.recent).toHaveLength(3);
    expect(v.mode.recent[0]).toMatchObject({
      kind: "mode",
      mode: { from: "auto", to: "sandbox" },
      by: `Name ${d.login}`,
      via: "web",
    });
    expect(v.mode.recent[1]).toMatchObject({ kind: "policy", add: [], remove: ["pypi.org"] });
    expect(v.mode.recent[2]).toMatchObject({
      add: ["files.slack.com", "*.npmjs.org"],
    });
    expect(v.mode).toMatchObject({
      mode: "sandbox",
      allowedMode: "auto",
      allowedBy: "platform",
      local: { reported: "sandbox" },
    });
  });

  it("lists only the last ten changes", async () => {
    const d = await owned();
    await connect(d, applying(POLICY));
    for (let i = 0; i < 11; i++) {
      const res = await post(d.req, d.deviceId, { add: [`h${i}.example.com`] });
      expect(res.statusCode, res.body).toBe(200);
    }
    const recent = (await view(d.req, d.deviceId)).mode.recent;
    expect(recent.map((r) => r.add[0])).toEqual(
      Array.from({ length: 10 }, (_, i) => `h${10 - i}.example.com`),
    );
    // the list view carries them too
    const list = await d.req({ method: "GET", url: base() });
    const item = (list.json() as { items: DeviceView[] }).items.find((i) => i.id === d.deviceId);
    expect(item?.mode.recent).toHaveLength(10);
  });

  it("another member and an org admin get 404; nothing is sent", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY));
    const other = await owned();
    const res = await post(other.req, d.deviceId, { add: ["files.slack.com"] });
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("device.not_found");
    const admin = await session(k, "owner");
    const viaAdmin = await post(admin, d.deviceId, { mode: "sandbox" });
    expect(viaAdmin.statusCode, viaAdmin.body).toBe(404);
    expect(policyReqs(machine)).toEqual([]);
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });

  it("the owner's personal access token → 403 auth.session_required; a service token → 403", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY));
    const tokens = apiTokensFor(db);
    const pat = await tokens.createPersonal(d.accountId, { name: "cli" });
    const viaPat = await k.http.inject({
      method: "POST",
      url: `${base()}/${d.deviceId}/policy`,
      headers: { authorization: `Bearer ${pat.token}`, "x-capybara-csrf": "1" },
      payload: { mode: "sandbox" },
    });
    expect(viaPat.statusCode, viaPat.body).toBe(403);
    expect(errCode(viaPat)).toBe("auth.session_required");
    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const viaService = await k.http.inject({
      method: "POST",
      url: `${base()}/${d.deviceId}/policy`,
      headers: { authorization: `Bearer ${token}`, "x-capybara-csrf": "1" },
      payload: { add: ["files.slack.com"] },
    });
    expect(viaService.statusCode, viaService.body).toBe(403);
    expect(policyReqs(machine)).toEqual([]);
  });

  it("validates the body", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY));
    for (const payload of [
      {},
      { add: [] },
      { add: ["http://evil.com"] },
      { add: ["10.0.0.1"] },
      { add: ["Files.Slack.com"] },
      { remove: ["localhost"] },
      { network: "open" },
      { mode: "auto" },
      { isolation: "none" },
      { add: ["a.example.com"], extra: true },
      { add: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) },
      { add: ["*.com"] },
      { add: ["*.co.uk"] },
      { add: ["*.github.io"] },
    ]) {
      const res = await post(d.req, d.deviceId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const suffix = await post(d.req, d.deviceId, { add: ["*.co.uk"] });
    expect(JSON.stringify(suffix.json())).toContain(
      "Use a narrower domain; *.co.uk covers a whole public suffix.",
    );
    expect(policyReqs(machine)).toEqual([]);
  });

  it("an offline machine → device.offline; nothing changed", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY));
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    const res = await post(d.req, d.deviceId, { add: ["files.slack.com"] });
    expect(res.statusCode, res.body).toBe(503);
    expect(errCode(res)).toBe("device.offline");
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });

  it("a program without the policyOpId feature → device.policy_unsupported", async () => {
    const d = await owned();
    const machine = await connect(d, applying(POLICY), { features: ["networkReport", "policyOp"] });
    const res = await post(d.req, d.deviceId, { remove: ["pypi.org"] });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.policy_unsupported");
    expect(policyReqs(machine)).toEqual([]);
  });

  it("the machine's own refusal (Docker mode) → 409 device.policy_refused with its message", async () => {
    const d = await owned();
    const machine = await connect(
      d,
      (req) =>
        req.op === "policy"
          ? { ok: false, error: { kind: "policy", message: DOCKER_MESSAGE } }
          : { ok: true, result: null },
      { ...FEATURES, mode: "docker" },
    );
    const res = await post(d.req, d.deviceId, { add: ["files.slack.com"] });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.policy_refused");
    expect(errMessage(res)).toBe(DOCKER_MESSAGE);
    expect(policyReqs(machine)).toHaveLength(1);
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });
});
