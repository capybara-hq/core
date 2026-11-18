import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  type DeviceHello,
  type DeviceLocalPolicySummary,
  type DeviceOwnerCeiling,
  type KernelReady,
  type KernelReq,
  type LegacyDeviceHello,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DevicePolicyService } from "../../src/local-devices/device-policy.service.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";
import {
  localProviderEntry,
} from "../../src/local-devices/local-devices.module.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { LOCAL_PROVIDER, SandboxProviders } from "../../src/sandbox/providers.js";
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
import { FakeMachine, HELLO } from "./fake-machine-v3.js";
import type { Answer } from "./test-holder.js";

/**
 * Owner-approved policy changes reach the device (network ask-to-allow spec §5.2, §5.4): the
 * `policy` op over the relay to a fake machine on a real WebSocket, the summary kept on the
 * machine's row, the `device.policy_changed` audit, and the outcomes that never throw (offline,
 * refused, a program without the feature).
 */

const POLICY: DeviceLocalPolicySummary = {
  mode: "auto",
  allowedDomains: ["pypi.org"],
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
  hello: Partial<LegacyDeviceHello> = {},
) {
  const machine = new FakeMachine(url, d.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.hello({ ...hello });
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

const FEATURES: Partial<LegacyDeviceHello> = {
  features: ["networkReport", "policyOp", "policyOpId", "mode"],
  policy: POLICY,
};

/** A machine that applies `policy` ops to `policy` and answers the new summary. */
function applying(policy: DeviceLocalPolicySummary): (req: KernelReq) => Answer {
  let now = policy;
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
    expect(req.args).toEqual({
      add: ["files.slack.com"],
      opId: expect.any(String),
      source: source(d.accountId),
    });
    expect(await policies.summary(d.deviceId)).toEqual({
      features: ["networkReport", "policyOp", "policyOpId", "mode"],
      policy: want,
    });
    expect(await auditsOf(d.deviceId)).toEqual([
      {
        action: "device.policy_changed",
        actor_account_id: d.accountId,
        org_id: orgId,
        detail: {
          opId: (req.args as { opId: string }).opId,
          add: ["files.slack.com"],
          remove: [],
          by: d.accountId,
          via: "web",
          approvalId: "ap-1",
        },
      },
    ]);
    // the owner's device page shows it
    const view = await devices.get(orgId, d.accountId, d.deviceId);
    expect(view.network).toEqual({
      features: ["networkReport", "policyOp", "policyOpId", "mode"],
      policy: want,
    });
    expect(view.mode.recent).toEqual([
      expect.objectContaining({
        kind: "policy",
        add: ["files.slack.com"],
        mode: null,
        via: "web",
        outcome: "applied",
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
    // the owner on the machine: `capybara-device mode sandbox`,
    // `policy add allowedDomains github.com`, `policy remove allowedDomains pypi.org`
    const own: DeviceLocalPolicySummary = {
      ...applied,
      mode: "sandbox",
      allowedDomains: ["files.slack.com", "github.com"],
    };
    machine.send({ type: "policy", policy: own });
    machine.send({ type: "policy", policy: own });
    await waitFor(
      async () => (await policies.summary(d.deviceId))?.policy?.mode === "sandbox",
      10_000,
      "own change recorded",
    );
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.detail)).toEqual([
      {
        opId: expect.any(String),
        add: ["files.slack.com"],
        remove: [],
        by: d.accountId,
        via: "web",
        approvalId: "ap-1",
      },
      {
        add: ["github.com"],
        remove: ["pypi.org"],
        by: d.accountId,
        via: "device",
        machineId: d.machineId,
        approvalId: null,
      },
    ]);
    expect(audits[1]?.actor_account_id).toBe(d.accountId);
    // the owner's mode change is its own audit row
    const modeAudits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", d.deviceId)
      .where("action", "=", "device.mode_changed")
      .execute();
    expect(modeAudits).toEqual([
      {
        detail: {
          from: "auto",
          to: "sandbox",
          by: d.accountId,
          via: "device",
          machineId: d.machineId,
        },
      },
    ]);
    // the device page lists the change and the mode separately, newest first
    const recent = (await devices.get(orgId, d.accountId, d.deviceId)).mode.recent;
    expect(recent).toEqual([
      expect.objectContaining({
        kind: "mode",
        mode: { from: "auto", to: "sandbox" },
        via: "device",
        outcome: "applied",
      }),
      expect.objectContaining({
        kind: "policy",
        add: ["github.com"],
        remove: ["pypi.org"],
        via: "device",
      }),
      expect.objectContaining({
        kind: "policy",
        add: ["files.slack.com"],
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

  it("a program without policyOpId is unsupported and is sent nothing", async () => {
    const d = await device();
    const machine = await connect(d, applying(POLICY), { features: ["networkReport", "policyOp"] });
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

  it("an answer that never comes is offline, and the op is audited unknown", async () => {
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
    // not applied as far as the platform knows: no change listed, the op left unknown
    expect(await auditsOf(d.deviceId)).toEqual([]);
    expect(
      await db
        .selectFrom("audit_events")
        .select(["action", "actor_account_id"])
        .where("target", "=", d.deviceId)
        .where("action", "like", "device.policy_%")
        .orderBy("id")
        .execute(),
    ).toEqual([
      { action: "device.policy_requested", actor_account_id: d.accountId },
      { action: "device.policy_unknown", actor_account_id: d.accountId },
    ]);
    // the summary stays what the machine last reported
    expect((await policies.summary(d.deviceId))?.policy).toEqual(POLICY);
  });

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
      { ...FEATURES, policy: { ...POLICY, mode: "sandbox" as const } },
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
      mode: "sandbox",
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

/**
 * A staged (protocol 3) machine connected to the kernel's own gateway (its dormant staged seam;
 * the HTTP route stays protocol 2 until the paired activation): records every request it gets and
 * answers a `policy` op with the summary and the next owner report it issues for the change.
 */
async function stagedMachine(
  d: { deviceId: string; machineId: string; credential: string },
  owner: DeviceOwnerCeiling,
  opts: {
    /** Runs before the `policy` answer goes out (the machine's own report of it, say). */
    beforeAnswer?: (next: DeviceOwnerCeiling, socket: WebSocket) => Promise<void>;
  } = {},
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("no address");
  server.on("connection", (socket) => {
    void k.app.get(LocalDeviceGateway).accept(socket, d.credential);
  });
  stagedCleanups.push(async () => {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(socket, "open");
  const requests: { op: string; args: Record<string, unknown> }[] = [];
  let ready: KernelReady | undefined;
  let current = owner;
  socket.on("message", async (data) => {
    const frame = parseDeviceFrame(data.toString(), "kernel", 69632);
    if (frame.type === "ready") {
      ready = frame;
      return;
    }
    if (frame.type !== "req") return;
    const args = { ...frame.args } as Record<string, unknown>;
    requests.push({ op: frame.op, args });
    if (frame.op !== "policy") return;
    const narrowing = (args.ownerCeiling ?? {}) as Partial<DeviceOwnerCeiling>;
    current = {
      ...current,
      ...narrowing,
      sequence: current.sequence + 1,
      revision: `r${current.sequence + 1}`,
    };
    await opts.beforeAnswer?.(current, socket);
    socket.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        result: {
          policy: { mode: current.fullAccess ? "auto" : "sandbox", allowedDomains: [] },
          ownerCeiling: current,
        },
      }),
    );
  });
  const hello: DeviceHello = {
    ...HELLO,
    protocol: 3,
    features: ["networkReport", "policyOp", "policyOpId"],
    policy: { mode: owner.fullAccess ? "auto" : "sandbox", allowedDomains: [] },
    transport: { maxFrameBytes: 69632 },
    permissionSupport: {
      version: 1,
      restricted: null,
      fullAccess: false,
      background: false,
      unavailableReason: "Not bound yet",
    },
    ownerCeiling: owner,
    instanceGeneration: null,
  };
  socket.send(JSON.stringify(hello));
  await waitFor(async () => ready !== undefined, 10_000, "staged ready");
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("owner_report")
          .where("id", "=", d.machineId)
          .executeTakeFirst()
      )?.owner_report != null,
    10_000,
    "staged hello recorded",
  );
  return { socket, requests, ready: () => ready as KernelReady };
}

const stagedCleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of stagedCleanups.splice(0).reverse()) await fn();
});

const OWNER_FULL: DeviceOwnerCeiling = {
  version: 2,
  sequence: 1,
  restrictedProjectReach: "os-user",
  revision: "r1",
  fullAccess: true,
  restrictedAllowedDomains: [],
};

const ownerReportOf = async (machineId: string) =>
  (
    await db
      .selectFrom("device_machines")
      .select("owner_report")
      .where("id", "=", machineId)
      .executeTakeFirstOrThrow()
  ).owner_report as { connectionId: string | null; via: string; report: DeviceOwnerCeiling };

const ceilingAudits = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "in", ["device.owner_ceiling_changed", "device.mode_changed"])
    .execute();

describe("staged (protocol 3) machines", () => {
  it("B-25: the gateway records the staged hello's owner report with its connection id", async () => {
    const d = await device();
    const m = await stagedMachine(d, OWNER_FULL);
    expect(await ownerReportOf(d.machineId)).toMatchObject({
      connectionId: m.ready().connectionId,
      via: "hello",
      report: OWNER_FULL,
    });
  });

  it("B-24: the local narrowing goes as a v3 policy op with an owner-ceiling narrowing, recorded with its connection, audited once", async () => {
    const d = await device();
    const m = await stagedMachine(d, OWNER_FULL);
    await devices.changePolicy(orgId, { id: d.accountId, displayName: "Me" }, d.deviceId, {
      ownerCeiling: { fullAccess: false },
    });
    const ops = m.requests.filter((r) => r.op === "policy");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.args).toMatchObject({ ownerCeiling: { fullAccess: false } });
    expect(ops[0]?.args).not.toHaveProperty("mode");
    expect(await ownerReportOf(d.machineId)).toMatchObject({
      connectionId: m.ready().connectionId,
      via: "policy-result",
      report: { sequence: 2, fullAccess: false },
    });
    // one row: the owner report's, as the web change made it (no derived mode_changed)
    expect(await ceilingAudits(d.deviceId)).toEqual([
      {
        action: "device.owner_ceiling_changed",
        actor_account_id: d.accountId,
        detail: expect.objectContaining({
          from: { fullAccess: true, restrictedProjectReach: "os-user" },
          to: { fullAccess: false, restrictedProjectReach: "os-user" },
          via: "web",
          opId: expect.any(String),
        }),
      },
    ]);
  });

  it("I1: the machine's own report of a web narrowing before the answer is audited once, as the op's", async () => {
    const d = await device();
    const m = await stagedMachine(d, OWNER_FULL, {
      // the device pushes its policy frame first and it is recorded before the answer arrives
      beforeAnswer: async (next, socket) => {
        socket.send(
          JSON.stringify({
            type: "policy",
            policy: { mode: "sandbox", allowedDomains: [] },
            ownerCeiling: next,
          }),
        );
        await waitFor(
          async () => (await ownerReportOf(d.machineId)).report.sequence === next.sequence,
          10_000,
          "the machine's own report recorded",
        );
      },
    });
    // the org owner acts on the member's device: an actor other than the machine's owner
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { ownerCeiling: { fullAccess: false } },
      source: { accountId: ownerId, accountName: "O", via: "web" },
    });
    expect(out).toMatchObject({ applied: true });
    const opId = m.requests.find((r) => r.op === "policy")?.args.opId;
    expect(typeof opId).toBe("string");
    expect(await ownerReportOf(d.machineId)).toMatchObject({ via: "policy" });
    expect(await ceilingAudits(d.deviceId)).toEqual([
      {
        action: "device.owner_ceiling_changed",
        actor_account_id: ownerId,
        detail: expect.objectContaining({ by: ownerId, via: "web", opId }),
      },
    ]);
  });

  it("B-24: protocol 2's sandbox switch reaches a staged machine as the narrowing it stands for, never wider", async () => {
    const d = await device();
    const m = await stagedMachine(d, OWNER_FULL);
    await devices.changePolicy(orgId, { id: d.accountId, displayName: "Me" }, d.deviceId, {
      mode: "sandbox",
    });
    const ops = m.requests.filter((r) => r.op === "policy");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.args).toMatchObject({
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" },
    });
    expect(ops[0]?.args).not.toHaveProperty("mode");
    expect((await ownerReportOf(d.machineId)).report).toMatchObject({
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
    // a widening is refused before anything is sent
    await expect(
      devices.changePolicy(orgId, { id: d.accountId, displayName: "Me" }, d.deviceId, {
        ownerCeiling: { fullAccess: true as never },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(m.requests.filter((r) => r.op === "policy")).toHaveLength(1);
  });

  it("an owner-ceiling narrowing is never sent over protocol 2", async () => {
    const d = await device();
    const machine = await connect(d, applying(POLICY), FEATURES);
    // even a machine whose earlier staged report is still on its row
    await db
      .updateTable("device_machines")
      .set({
        owner_report: JSON.stringify({
          report: OWNER_FULL,
          connectionId: "old",
          observedAt: new Date().toISOString(),
          via: "hello",
        }),
      })
      .where("id", "=", d.machineId)
      .execute();
    const out = await policies.apply({
      orgId,
      deviceId: d.deviceId,
      change: { ownerCeiling: { fullAccess: false } },
      source: source(d.accountId),
    });
    expect(out).toMatchObject({ applied: false, reason: "unsupported" });
    expect(machine.frames.filter((f) => f.type === "req" && f.op === "policy")).toEqual([]);
  });

  it("B-25: a staged policy frame changing Full is audited once, as the owner report", async () => {
    const d = await device();
    const m = await stagedMachine(d, OWNER_FULL);
    m.socket.send(
      JSON.stringify({
        type: "policy",
        policy: { mode: "sandbox", allowedDomains: [] },
        ownerCeiling: { ...OWNER_FULL, sequence: 2, revision: "r2", fullAccess: false },
      }),
    );
    await waitFor(
      async () => (await ownerReportOf(d.machineId)).report.sequence === 2,
      10_000,
      "policy frame recorded",
    );
    expect(await ownerReportOf(d.machineId)).toMatchObject({
      connectionId: m.ready().connectionId,
      via: "policy",
    });
    expect((await ceilingAudits(d.deviceId)).map((a) => a.action)).toEqual([
      "device.owner_ceiling_changed",
    ]);
  });

  it("registration: the active @local entry is the protocol 3 provider with the instance binder", () => {
    const deps = {
      provider: k.app.get(LocalDeviceProvider),
      relay: k.app.get(LocalDeviceRelay),
      bindings: k.app.get(LocalInstanceBindings),
    };
    const staged = localProviderEntry(deps);
    expect(staged.binder).toBe(k.app.get(LocalInstanceBindings));
    expect(staged.impl).not.toBe(deps.provider);
    expect(typeof staged.impl.revokeOperation).toBe("function");
    const active = k.app.get(SandboxProviders).forName(LOCAL_PROVIDER);
    expect(active?.binder).toBe(k.app.get(LocalInstanceBindings));
    expect(active?.impl).not.toBe(deps.provider);
    expect(typeof active?.impl.revokeOperation).toBe("function");
  });
});
