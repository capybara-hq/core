import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DeviceProvider,
  DeviceRef,
  DeviceReport,
  SandboxHandle,
  SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { DeviceReports } from "../../src/sandbox/device-reports.js";
import type { DeviceProviderEntry } from "../../src/sandbox/providers.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { guardProviderConnection } from "../../src/sandbox/unreachable.js";
import {
  createFakeSandbox,
  DEFAULT_DESCRIPTION,
  FAKE_INSTANCE_PERMISSION_SUPPORT,
  FAKE_PERMISSION_SUPPORT,
  readFakeSandboxOps,
} from "../fixtures/plugins/device-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { deviceReportsFor, sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";

/**
 * The stored device report (device-provider spec §6.1, phase 1 Task 9): a create or a resume asks
 * the device's provider for its report and stores it in `devices.report`; reads come from PG and
 * never call the provider; a failing or invalid answer keeps the stored report and never fails
 * the use; a report is written only while the device is still bound to the provider that answered.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let orgId: string;
let accountId: string;
let conversationId: string;
/** `device-fake`'s implementation; `report` is replaced per test through {@link answer}. */
let fake: DeviceProvider;
/** What the provider's `report` does now (default: the fake's own answer). */
let answer: (device: DeviceRef, signal: AbortSignal) => Promise<unknown>;
/** What the provider's `permissionSupport` does now (default: the fake's own answer). */
let supportAnswer: (h: SandboxHandle, signal: AbortSignal) => Promise<unknown>;
let reportCalls: number;
let entry: DeviceProviderEntry;
let reports: DeviceReports;
let warn: ReturnType<typeof vi.fn<(msg: string, fields?: Record<string, unknown>) => void>>;

const DAY = 24 * 60 * 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const signal = () => AbortSignal.timeout(30_000);

const report = (revision: string): DeviceReport => ({
  revision,
  description: { en: `Device at ${revision}`, zh: `设备 ${revision}` },
  home: null,
  limits: [{ label: { en: "CPU" }, value: "2" }],
  reset: true,
});

const service = (r: DeviceReports = reports): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    providers: () => [entry],
    config: () => config,
    log: { warn },
    lockPollMs: 20,
    reports: r,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
});

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.sandbox_operation_intents, capybara.permission_authority_epochs, capybara.outbox, capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-device-report-"));
  fake = createFakeSandbox(root);
  answer = (device, sig) => fake.report(device, sig);
  supportAnswer = (h, sig) =>
    (fake.permissionSupport as NonNullable<typeof fake.permissionSupport>)(h, sig);
  reportCalls = 0;
  // the provider the kernel sees: the fake with a scriptable `report`
  const impl = Object.create(fake) as DeviceProvider;
  Object.defineProperty(impl, "report", {
    value: (device: DeviceRef, sig: AbortSignal) => {
      reportCalls++;
      return answer(device, sig);
    },
  });
  Object.defineProperty(impl, "permissionSupport", {
    value: (h: SandboxHandle, sig: AbortSignal) => supportAnswer(h, sig),
  });
  entry = { plugin: "device-fake", version: "1.0.0", impl };
  warn = vi.fn();
  reports = deviceReportsFor(db, redis, { warn }, undefined, () => [entry]);
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  accountId = randomUUID();
  orgId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  const agentId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  conversationId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
});

/** Runs `echo` in the device (a use). */
const run = (s: SandboxService, deviceId: string) =>
  s.withSandbox(
    {
      orgId,
      deviceId,
      holderConversationId: conversationId,
      actor: { accountId, conversationId },
    },
    async (h, p, _i, sig) => {
      const r = await p.exec(h, {
        command: "echo hi",
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
        signal: sig,
      });
      expect(r.stdout.trim()).toBe("hi");
    },
    signal(),
  );

const stored = (deviceId: string) =>
  db
    .selectFrom("devices")
    .select(["report", "report_at"])
    .where("id", "=", deviceId)
    .executeTakeFirstOrThrow();

const reportWarnings = () =>
  warn.mock.calls.filter(([msg]) => String(msg).startsWith("cannot refresh the device report"));

/** The `changed` answers of every refresh the service made, in order. */
function watchRefreshes(): Promise<{ changed: boolean }>[] {
  const out: Promise<{ changed: boolean }>[] = [];
  const original = reports.refresh.bind(reports);
  vi.spyOn(reports, "refresh").mockImplementation((...args) => {
    const p = original(...args);
    out.push(p);
    return p;
  });
  return out;
}

describe("the stored device report", () => {
  it("a first use stores the provider's report; read returns it without calling the provider", async () => {
    const s = service();
    const id = await seedDevice(raw, orgId, accountId);
    expect(await reports.read(orgId, id)).toBeNull();
    await run(s, id);
    const fsId = (await readFakeSandboxOps(root)).find((o) => o[0] === "create-fs")?.[1];
    expect(fsId).toBeTruthy();
    const want: DeviceReport = {
      revision: String(fsId),
      description: { en: DEFAULT_DESCRIPTION },
      home: null,
      limits: [],
      reset: true,
    };
    expect(await stored(id)).toMatchObject({ report: want, report_at: expect.any(Date) });
    expect(reportCalls).toBe(1);
    // reads (and a use of the running instance) never call the provider
    expect(await reports.read(orgId, id)).toEqual(want);
    await run(s, id);
    expect(reportCalls).toBe(1);
    // another org's id, or a deleted device: nothing
    expect(await reports.read(randomUUID(), id)).toBeNull();
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${id}`.execute(raw);
    expect(await reports.read(orgId, id)).toBeNull();
  });

  it("a resume refreshes it; changed is true only when the revision differs", async () => {
    const s = service();
    const id = await seedDevice(raw, orgId, accountId);
    const refreshes = watchRefreshes();
    answer = async () => report("r1");
    await run(s, id);
    expect(await Promise.all(refreshes)).toEqual([{ changed: true }]);
    const first = await stored(id);

    // a resume with the same revision: stored again (report_at moves), not changed
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    await run(s, id);
    expect(await Promise.all(refreshes)).toEqual([{ changed: true }, { changed: false }]);
    const second = await stored(id);
    expect(await reports.read(orgId, id)).toEqual(report("r1"));
    expect(second.report_at?.getTime()).toBeGreaterThan(first.report_at?.getTime() ?? Infinity);

    // a resume with a new revision: changed, and read returns the new one
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    answer = async () => report("r2");
    await run(s, id);
    expect(await Promise.all(refreshes)).toEqual([
      { changed: true },
      { changed: false },
      { changed: true },
    ]);
    expect(await reports.read(orgId, id)).toEqual(report("r2"));
    expect(reportCalls).toBe(3);
  });

  it("an invalid or failing report keeps the stored one and never fails the use", async () => {
    const s = service();
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    await run(s, id);
    const kept = await stored(id);

    // an answer that does not pass parseDeviceReport
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    answer = async () => ({ ...report("r2"), revision: "" });
    await run(s, id);
    expect(await stored(id)).toEqual(kept);
    expect(reportWarnings()).toHaveLength(1);

    // a provider that throws: still kept, and logged at most once per device per hour
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    answer = async () => {
      throw new Error("report backend down");
    };
    await run(s, id);
    expect(await stored(id)).toEqual(kept);
    expect(reportWarnings()).toHaveLength(1);
    expect(await reports.read(orgId, id)).toEqual(report("r1"));

    // an invalid stored copy reads as none
    await sql`UPDATE capybara.devices SET report = '{"revision": 1}'::jsonb WHERE id = ${id}`.execute(
      raw,
    );
    expect(await reports.read(orgId, id)).toBeNull();

    // a first use whose report fails stores nothing, and the use still runs
    const other = await seedDevice(raw, orgId, accountId);
    await run(s, other);
    expect(await stored(other)).toEqual({ report: null, report_at: null });
    expect(reportWarnings()).toHaveLength(2);
  });

  it("a report is never written for a device whose provider changed under it", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    const ref = { deviceId: id, orgId, handle: null };
    // an answer from a provider the device is not bound to
    const other: DeviceProviderEntry = { ...entry, plugin: "device-fake-b" };
    answer = async () => report("r1");
    expect(await reports.refresh(other, ref, signal())).toEqual({ changed: false });
    expect(await stored(id)).toEqual({ report: null, report_at: null });

    // the device rebound to another provider while its provider was answering
    answer = async () => {
      await sql`UPDATE capybara.devices SET provider = 'device-fake-b' WHERE id = ${id}`.execute(
        raw,
      );
      return report("r2");
    };
    expect(await reports.refresh(entry, ref, signal())).toEqual({ changed: false });
    expect(await stored(id)).toEqual({ report: null, report_at: null });
    // neither is a failure worth a warning
    expect(reportWarnings()).toHaveLength(0);

    // bound to it again: written
    answer = async () => report("r3");
    await sql`UPDATE capybara.devices SET provider = 'device-fake' WHERE id = ${id}`.execute(raw);
    expect(await reports.refresh(entry, ref, signal())).toEqual({ changed: true });
    expect(await reports.read(orgId, id)).toEqual(report("r3"));
  });

  it("a provider whose report never settles and ignores its signal is given up at the bound; the device stays usable", async () => {
    const bounded = deviceReportsFor(db, redis, { warn }, 50);
    const s = service(bounded);
    const id = await seedDevice(raw, orgId, accountId);
    let seen: AbortSignal | undefined;
    answer = (_device, sig) => {
      seen = sig;
      return new Promise<never>(() => {});
    };
    // the use that creates the instance completes although the report never does
    await run(s, id);
    expect(seen?.aborted).toBe(true);
    expect(await stored(id)).toEqual({ report: null, report_at: null });
    expect(reportWarnings()).toHaveLength(1);
    // the exclusive lease was released: the next use and a resume run too
    await run(s, id);
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    await run(s, id);
    // a direct refresh returns within the bound, writing nothing
    const ref = { deviceId: id, orgId, handle: null };
    const started = Date.now();
    expect(await bounded.refresh(entry, ref, signal())).toEqual({ changed: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await stored(id)).toEqual({ report: null, report_at: null });
  });

  it("a guarded extension provider hands report its arguments and answer unchanged", async () => {
    const ref = { deviceId: randomUUID(), orgId, handle: null };
    const sig = signal();
    const spy = vi.fn(async (_d: DeviceRef, _s: AbortSignal) => report("g1"));
    const impl = Object.create(fake) as DeviceProvider;
    Object.defineProperty(impl, "report", { value: spy, writable: true, configurable: true });
    expect(await guardProviderConnection(impl).report(ref, sig)).toEqual(report("g1"));
    expect(spy).toHaveBeenCalledWith(ref, sig);
  });
});

/**
 * The report revision drives the provider-neutral device authority epoch (device-provider spec
 * §6.7): `changed` (behind `ctx.devices.reportChanged`) and a kernel refresh both publish a device
 * ceiling change when a stored revision is replaced, revoking running work only for the crossings
 * the provider's new permission support can no longer enforce.
 */
describe("the report revision and the device authority epoch", () => {
  /** The device's authority epoch row (absent: revision 0, never written). */
  const epoch = async (deviceId: string) =>
    (await db
      .selectFrom("permission_authority_epochs")
      .select(["revision", "full_revision"])
      .where("kind", "=", "device")
      .where("id", "=", deviceId)
      .executeTakeFirst()) ?? { revision: 0, full_revision: 0 };

  /** A running instance of `device-fake` for the device, so `changed` reads its support. */
  const seedInstance = async (deviceId: string) => {
    await db
      .insertInto("device_instances")
      .values({
        device_id: deviceId,
        org_id: orgId,
        provider: "device-fake",
        status: "running",
        handle: JSON.stringify({ id: `inst-${deviceId}` }),
        fs_status: "ready",
        had_instance: true,
      })
      .execute();
  };

  /** A started operation on the device: escalated (outside the sandbox) or not, with hosts. */
  const seedIntent = async (
    deviceId: string,
    o: { escalated: boolean; hosts?: string[] },
  ): Promise<string> => {
    const operationId = randomUUID();
    const scope = o.escalated
      ? {
          profile: "approve-for-me",
          filesystem: { kind: "device" },
          network: { kind: "environment" },
        }
      : {
          profile: "approve-for-me",
          filesystem: { kind: "scoped", projectRoot: "/workspace", writeRoots: ["/workspace"] },
          network: { kind: "allowlist", hosts: o.hosts ?? [] },
        };
    await db
      .insertInto("sandbox_operation_intents")
      .values({
        operation_id: operationId,
        org_id: orgId,
        account_id: accountId,
        device_id: deviceId,
        root_conversation_id: conversationId,
        conversation_id: conversationId,
        run_id: randomUUID(),
        call_id: "call",
        ordinal: 0,
        method: "exec",
        input_hash: "h",
        admission_hash: "h",
        granted_hosts: JSON.stringify(o.hosts ?? []),
        execution_grants: JSON.stringify({ version: 1, grants: null }),
        input: JSON.stringify({}),
        scope: JSON.stringify(scope),
        epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
        provider: "device-fake",
        provider_version: "1.0.0",
        instance_generation: "1",
        deadline: later(60_000),
        retain_until: later(DAY),
        execution_id: randomUUID(),
        state: "started-or-unknown",
      })
      .execute();
    return operationId;
  };

  const intentState = async (operationId: string) =>
    (
      await db
        .selectFrom("sandbox_operation_intents")
        .select("state")
        .where("operation_id", "=", operationId)
        .executeTakeFirstOrThrow()
    ).state;

  /** Puts the holder conversation on the device under Full access. */
  const fullAccessOn = async (deviceId: string) =>
    db
      .updateTable("conversations")
      .set({ device_id: deviceId, permission_profile: "full-access" })
      .where("id", "=", conversationId)
      .execute();

  const profile = async () =>
    (
      await db
        .selectFrom("conversations")
        .select("permission_profile")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow()
    ).permission_profile;

  it("a first report publishes nothing; a replaced revision bumps the device epoch", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    expect(await reports.changed("device-fake", id)).toBe("same");
    expect(await epoch(id)).toEqual({ revision: 0, full_revision: 0 });
    expect(await reports.current(id)).toEqual({ revision: "r1", support: null });
    answer = async () => report("r2");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect((await epoch(id)).revision).toBe(1);
    expect(await reports.read(orgId, id)).toEqual(report("r2"));
  });

  it("reportChanged with an unchanged revision does not bump the device epoch", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    await reports.changed("device-fake", id);
    answer = async () => report("r2");
    await reports.changed("device-fake", id);
    const before = await epoch(id);
    expect(await reports.changed("device-fake", id)).toBe("same");
    expect(await epoch(id)).toEqual(before);
  });

  it("reportChanged for a device of another provider is refused and bumps nothing", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    await reports.changed("device-fake", id);
    answer = async () => report("r2");
    expect(await reports.changed("device-fake-b", id)).toBe("not-served");
    // a deleted device, or one that does not exist: refused too
    expect(await reports.changed("device-fake", randomUUID())).toBe("not-served");
    expect(reportCalls).toBe(1);
    expect(await epoch(id)).toEqual({ revision: 0, full_revision: 0 });
    expect(await reports.read(orgId, id)).toEqual(report("r1"));
    await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${id}`.execute(raw);
    expect(await reports.changed("device-fake", id)).toBe("not-served");
    expect(reportCalls).toBe(1);
  });

  it("a report that fails is thrown to the provider and changes nothing", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    await reports.changed("device-fake", id);
    answer = async () => ({ ...report("r2"), revision: "" });
    await expect(reports.changed("device-fake", id)).rejects.toThrow("revision");
    expect(await epoch(id)).toEqual({ revision: 0, full_revision: 0 });
    expect(await reports.read(orgId, id)).toEqual(report("r1"));
  });

  it("a revision change that removes outsideSandbox revokes running outside-sandbox work and resets full consent", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    await seedInstance(id);
    await fullAccessOn(id);
    answer = async () => report("r1");
    supportAnswer = async () => FAKE_PERMISSION_SUPPORT;
    await reports.changed("device-fake", id);
    expect((await reports.current(id))?.support).toEqual(FAKE_PERMISSION_SUPPORT);
    const escalated = await seedIntent(id, { escalated: true });
    const sandboxed = await seedIntent(id, { escalated: false, hosts: ["example.com"] });
    answer = async () => report("r2");
    supportAnswer = async () => ({ ...FAKE_PERMISSION_SUPPORT, outsideSandbox: false });
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect(await intentState(escalated)).toBe("revoked");
    // per-call hosts are still enforceable: the sandboxed work keeps running
    expect(await intentState(sandboxed)).toBe("started-or-unknown");
    expect(await epoch(id)).toEqual({ revision: 1, full_revision: 1 });
    expect(await profile()).toBe("approve-for-me");
    // the revocation is owed through the outbox
    expect(
      await db
        .selectFrom("outbox")
        .select("job_id")
        .where("job_id", "=", `sandbox-operation-revoke-${escalated}`)
        .execute(),
    ).toHaveLength(1);
  });

  it("a revision change that keeps the support bumps the epoch but revokes nothing", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    await seedInstance(id);
    await fullAccessOn(id);
    answer = async () => report("r1");
    supportAnswer = async () => FAKE_PERMISSION_SUPPORT;
    await reports.changed("device-fake", id);
    const escalated = await seedIntent(id, { escalated: true });
    const sandboxed = await seedIntent(id, { escalated: false, hosts: ["example.com"] });
    answer = async () => report("r2");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect(await intentState(escalated)).toBe("started-or-unknown");
    expect(await intentState(sandboxed)).toBe("started-or-unknown");
    expect(await epoch(id)).toEqual({ revision: 1, full_revision: 0 });
    expect(await profile()).toBe("full-access");
  });

  it("an instance-boundary provider keeps Full access across revisions; a support it cannot read revokes every crossing", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    await seedInstance(id);
    await fullAccessOn(id);
    answer = async () => report("r1");
    supportAnswer = async () => FAKE_INSTANCE_PERMISSION_SUPPORT;
    await reports.changed("device-fake", id);
    answer = async () => report("r2");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    // nothing outside the sandbox before or after: the consent stands
    expect(await epoch(id)).toEqual({ revision: 1, full_revision: 0 });
    expect(await profile()).toBe("full-access");

    // a failing support read: no crossing is enforceable (fail closed), the revision still counts
    supportAnswer = async () => FAKE_PERMISSION_SUPPORT;
    answer = async () => report("r3");
    await reports.changed("device-fake", id);
    const escalated = await seedIntent(id, { escalated: true });
    const hosted = await seedIntent(id, { escalated: false, hosts: ["example.com"] });
    const plain = await seedIntent(id, { escalated: false });
    supportAnswer = async () => {
      throw new Error("support backend down");
    };
    answer = async () => report("r4");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect(await intentState(escalated)).toBe("revoked");
    expect(await intentState(hosted)).toBe("revoked");
    expect(await intentState(plain)).toBe("started-or-unknown");
    expect((await reports.current(id))?.support).toBeNull();
  });

  it("a revision change on a device without an instance keeps the stored support and Full consent", async () => {
    const id = await seedDevice(raw, orgId, accountId);
    await seedInstance(id);
    await fullAccessOn(id);
    answer = async () => report("r1");
    supportAnswer = async () => FAKE_PERMISSION_SUPPORT;
    await reports.changed("device-fake", id);
    // the instance goes away (destroyed, or a dial-in device with none yet)
    await db.deleteFrom("device_instances").where("device_id", "=", id).execute();
    const probes = vi.fn(async () => FAKE_PERMISSION_SUPPORT as SandboxPermissionSupport);
    supportAnswer = probes;
    answer = async () => report("r2");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect(probes).not.toHaveBeenCalled();
    expect((await reports.current(id))?.support).toEqual(FAKE_PERMISSION_SUPPORT);
    expect(await epoch(id)).toEqual({ revision: 1, full_revision: 0 });
    expect(await profile()).toBe("full-access");
    // the next instance-backed report with the same support resets nothing either
    await seedInstance(id);
    answer = async () => report("r3");
    expect(await reports.changed("device-fake", id)).toBe("bumped");
    expect(await epoch(id)).toEqual({ revision: 2, full_revision: 0 });
    expect(await profile()).toBe("full-access");
  });

  it("a kernel refresh that replaces the revision publishes the same change", async () => {
    const s = service();
    const id = await seedDevice(raw, orgId, accountId);
    answer = async () => report("r1");
    await run(s, id);
    expect(await epoch(id)).toEqual({ revision: 0, full_revision: 0 });
    // a resume with the same revision: nothing
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    await run(s, id);
    expect((await epoch(id)).revision).toBe(0);
    // a resume answering another revision: the epoch moves, so a later reportChanged is `same`
    expect(await s.suspendIdle(later(DAY))).toBe(1);
    answer = async () => report("r2");
    await run(s, id);
    expect((await epoch(id)).revision).toBe(1);
    expect(await reports.changed("device-fake", id)).toBe("same");
    expect((await epoch(id)).revision).toBe(1);
    // a refresh adds no support probe: the support stored by the last reportChanged is kept
    const probes = vi.fn(async () => FAKE_PERMISSION_SUPPORT as SandboxPermissionSupport);
    supportAnswer = probes;
    expect(await reports.changed("device-fake", id)).toBe("same");
    expect(probes).toHaveBeenCalledTimes(1);
    answer = async () => report("r3");
    const handle = { id: `inst-${id}` };
    expect(await reports.refresh(entry, { deviceId: id, orgId, handle }, signal())).toEqual({
      changed: true,
    });
    expect(probes).toHaveBeenCalledTimes(1);
    expect((await epoch(id)).revision).toBe(2);
    expect((await reports.current(id))?.support).toEqual(FAKE_PERMISSION_SUPPORT);
  });
});
