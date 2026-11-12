import { randomUUID } from "node:crypto";
import type { DeviceHello, DeviceLocalPolicySummary, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DevicePolicyService } from "../../src/local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, HELLO } from "./fake-machine.js";
import type { Answer } from "./test-holder.js";

/**
 * Owner-approved policy changes reach the device (network ask-to-allow spec §5.2, §5.4): the
 * `policy` op over the relay to a fake machine on a real WebSocket, the summary kept on the
 * machine's row, the `device.policy_changed` audit, and the outcomes that never throw (offline,
 * refused, a program without the feature).
 */

const POLICY: DeviceLocalPolicySummary = {
  effectiveTier: "strict",
  isolation: "sandbox",
  localhost: "off",
  unixSockets: "off",
  allowedDomains: ["pypi.org"],
  remoteGrants: "owner",
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let policies: DevicePolicyService;
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
  policies = k.app.get(DevicePolicyService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member with a local device and a signed-in machine (not connected). */
async function device(org = orgId) {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(org, accountId, "member", ownerId);
  return txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(org, accountId, "Box");
    const issued = await machines.issue({
      orgId: org,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { accountId, deviceId, ...issued };
  });
}

/** Connects the machine with `hello` and waits until its lease and hello are recorded. */
async function connect(
  d: { deviceId: string; machineId: string; credential: string },
  answer: (req: KernelReq) => Answer,
  hello: Partial<DeviceHello> = {},
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

const FEATURES: Partial<DeviceHello> = { features: ["networkReport", "policyOp"], policy: POLICY };

/** A machine that applies `policy` ops to `policy` and answers the new summary. */
function applying(policy: DeviceLocalPolicySummary): (req: KernelReq) => Answer {
  let now = policy;
  return (req) => {
    if (req.op !== "policy") return { ok: true, result: null };
    const a = req.args as { add?: string[]; remove?: string[] };
    const domains = new Set(now.allowedDomains);
    for (const h of a.add ?? []) domains.add(h);
    for (const h of a.remove ?? []) domains.delete(h);
    now = { ...now, allowedDomains: [...domains] };
    return { ok: true, result: { policy: now } };
  };
}

const source = (accountId: string) => ({
  approvalId: "ap-1",
  accountId,
  accountName: "Me",
  via: "web" as const,
});

const auditsOf = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "org_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "=", "device.policy_changed")
    .execute();

describe("DevicePolicyService.apply", () => {
  it("sends the policy op, stores the machine's summary and audits the change", async () => {
    const d = await device();
    const machine = await connect(d, applying(POLICY), FEATURES);
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    const want = { ...POLICY, allowedDomains: ["pypi.org", "files.slack.com"] };
    expect(out).toEqual({ applied: true, policy: want });
    const req = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    expect(req.args).toEqual({ add: ["files.slack.com"], source: source(d.accountId) });
    expect(await policies.summary(d.deviceId)).toEqual({
      features: ["networkReport", "policyOp"],
      policy: want,
    });
    expect(await auditsOf(d.deviceId)).toEqual([
      {
        action: "device.policy_changed",
        actor_account_id: d.accountId,
        org_id: orgId,
        detail: {
          add: ["files.slack.com"],
          remove: [],
          by: d.accountId,
          via: "web",
          approvalId: "ap-1",
          confirmed: true,
        },
      },
    ]);
    // the owner's device page shows it
    const view = await devices.get(orgId, d.accountId, d.deviceId);
    expect(view.network).toEqual({
      features: ["networkReport", "policyOp"],
      policy: want,
    });
    expect(view.sandbox.recent).toEqual([
      expect.objectContaining({
        kind: "policy",
        add: ["files.slack.com"],
        tier: null,
        via: "web",
        confirmed: true,
      }),
    ]);
  });

  it("lists the platform's op once, however the machine reports it, and the owner's own change as the machine's", async () => {
    const d = await device();
    let machine: FakeMachine | undefined;
    const apply = applying(POLICY);
    // the machine reports the new summary by itself before it answers the op
    const answer = (req: KernelReq): Answer => {
      const a = apply(req);
      if (req.op === "policy" && a?.ok) {
        machine?.send({ type: "policy", policy: (a.result as { policy: unknown }).policy });
      }
      return a;
    };
    machine = await connect(d, answer, FEATURES);
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    expect(out).toMatchObject({ applied: true });
    const applied = { ...POLICY, allowedDomains: ["pypi.org", "files.slack.com"] };
    // reported again after the answer: no change
    machine.send({ type: "policy", policy: applied });
    // the owner on the machine: `policy set tier open`, `policy set remoteGrants off`,
    // `policy add allowedDomains github.com`, `policy remove allowedDomains pypi.org`
    const own: DeviceLocalPolicySummary = {
      ...applied,
      tier: "open",
      effectiveTier: "open",
      localhost: "on",
      remoteGrants: "off",
      allowedDomains: ["files.slack.com", "github.com"],
    };
    machine.send({ type: "policy", policy: own });
    machine.send({ type: "policy", policy: own });
    await waitFor(
      async () => (await policies.summary(d.deviceId))?.policy?.remoteGrants === "off",
      10_000,
      "own change recorded",
    );
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.detail)).toEqual([
      {
        add: ["files.slack.com"],
        remove: [],
        by: d.accountId,
        via: "web",
        approvalId: "ap-1",
        confirmed: true,
      },
      {
        add: ["github.com"],
        remove: ["pypi.org"],
        tier: "open",
        tierFrom: null,
        localhost: "on",
        remoteGrants: "off",
        by: d.accountId,
        via: "device",
        machineId: d.machineId,
        approvalId: null,
        confirmed: true,
      },
    ]);
    expect(audits[1]?.actor_account_id).toBe(d.accountId);
    // the device page lists both, newest first, with where each was made
    const recent = (await devices.get(orgId, d.accountId, d.deviceId)).sandbox.recent;
    expect(recent).toEqual([
      expect.objectContaining({
        kind: "policy",
        add: ["github.com"],
        remove: ["pypi.org"],
        tier: { from: null, to: "open" },
        localhost: "on",
        remoteGrants: "off",
        isolation: null,
        via: "device",
        confirmed: true,
      }),
      expect.objectContaining({
        kind: "policy",
        add: ["files.slack.com"],
        tier: null,
        localhost: null,
        remoteGrants: null,
        via: "web",
      }),
    ]);
    // nothing left pending once the answer is recorded
    expect(
      (
        await db
          .selectFrom("device_machines")
          .select("pending_policy_ops")
          .where("id", "=", d.machineId)
          .executeTakeFirstOrThrow()
      ).pending_policy_ops,
    ).toEqual([]);
  });

  it("a program without policyOp is unsupported and is sent nothing", async () => {
    const d = await device();
    const machine = await connect(d, applying(POLICY), { features: ["networkReport"] });
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    expect(out).toMatchObject({ applied: false, reason: "unsupported" });
    expect(machine.frames.filter((f) => f.type === "req" && f.op === "policy")).toEqual([]);
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });

  it("an offline machine is offline; a device without a machine too", async () => {
    const d = await device();
    // signed in with the feature, then gone
    const machine = await connect(d, applying(POLICY), FEATURES);
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    expect(out).toMatchObject({ applied: false, reason: "offline" });

    await txHost.run(() => machines.revokeActive(d.deviceId, null));
    expect(
      await policies.apply({
        orgId,
        deviceId: d.deviceId,
        change: { remove: ["pypi.org"] },
        source: source(d.accountId),
      }),
    ).toMatchObject({ applied: false, reason: "offline" });
    expect(await policies.summary(d.deviceId)).toBeNull();
    expect((await devices.get(orgId, d.accountId, d.deviceId)).network).toBeNull();
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });

  it("an answer that never comes is offline, and the attempt is audited unconfirmed", async () => {
    const d = await device();
    // the machine takes the op, then drops without answering
    const machine = await connect(
      d,
      (req) => (req.op === "policy" ? undefined : { ok: true, result: null }),
      FEATURES,
    );
    void machine.next((f) => f.type === "req" && f.op === "policy").then(() => machine.close());
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    expect(out).toMatchObject({ applied: false, reason: "offline" });
    expect(await auditsOf(d.deviceId)).toEqual([
      expect.objectContaining({
        actor_account_id: d.accountId,
        detail: expect.objectContaining({ add: ["files.slack.com"], confirmed: false }),
      }),
    ]);
    // the summary stays what the machine last reported
    expect((await policies.summary(d.deviceId))?.policy).toEqual(POLICY);
  }, 60_000);

  it("a device refusing with kind policy is refused with its message; nothing is stored", async () => {
    const d = await device();
    const message =
      "This device does not accept network changes from the deployment; allow it locally with capybara-device policy add allowedDomains files.slack.com";
    await connect(
      d,
      (req) =>
        req.op === "policy"
          ? { ok: false, error: { kind: "policy", message } }
          : { ok: true, result: null },
      { ...FEATURES, policy: { ...POLICY, remoteGrants: "off" } },
    );
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { add: ["files.slack.com"] },
      source: source(d.accountId),
    });
    expect(out).toEqual({ applied: false, reason: "refused", message });
    expect((await policies.summary(d.deviceId))?.policy).toEqual({
      ...POLICY,
      remoteGrants: "off",
    });
    expect(await auditsOf(d.deviceId)).toEqual([]);
  });

  it("a device of another org is not found", async () => {
    const otherOrg = await createOrg(await session(k, "owner"), "Other");
    const d = await device(otherOrg);
    const e = await policies
      .apply({
        orgId,
        deviceId: d.deviceId,
        change: { add: ["files.slack.com"] },
        source: source(d.accountId),
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(e instanceof ApiError && e.code === "device.not_found").toBe(true);
  });

  it("refuses to run inside a transaction, and wildcards to add", async () => {
    const d = await device();
    await expect(
      txHost.run(() =>
        policies.apply({
          orgId,
          deviceId: d.deviceId,
          change: { add: ["files.slack.com"] },
          source: source(d.accountId),
        }),
      ),
    ).rejects.toThrow(/must not run inside a transaction/);
    await expect(
      policies.apply({
        orgId,
        deviceId: d.deviceId,
        change: { add: ["*.slack.com"] },
        source: source(d.accountId),
      }),
    ).rejects.toThrow(/not an exact host/);
  });
});
