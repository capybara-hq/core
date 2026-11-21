import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceProvider, DeviceRef, DeviceReport } from "@capybara-hq/plugin-sdk";
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
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-device-report-"));
  fake = createFakeSandbox(root);
  answer = (device, sig) => fake.report(device, sig);
  reportCalls = 0;
  // the provider the kernel sees: the fake with a scriptable `report`
  const impl = Object.create(fake) as DeviceProvider;
  Object.defineProperty(impl, "report", {
    value: (device: DeviceRef, sig: AbortSignal) => {
      reportCalls++;
      return answer(device, sig);
    },
  });
  entry = { plugin: "device-fake", version: "1.0.0", impl };
  warn = vi.fn();
  reports = deviceReportsFor(db, redis, { warn });
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
    expect(second.report).toEqual(report("r1"));
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
