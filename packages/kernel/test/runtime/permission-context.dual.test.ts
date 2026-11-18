import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { ExecutionRevoked, RunExecution } from "../../src/runtime/run-execution.js";
import { ManagedDeviceContextRecorder } from "../../src/sandbox/managed-device-context.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { PermissionTransitions } from "../../src/sandbox/permission-transitions.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { gate, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import {
  type ContextFixture,
  contexts,
  inputOf,
  ROOTS,
  recordUnder,
  seedContext,
  spyProvider,
} from "./permission-context-fixture.js";

/**
 * Two kernels (each its own pool, transaction host and recorder) over one PostgreSQL and Redis:
 * the permission context is decided by the persisted log under the conversation lock, never by a
 * replica's memory, and a replaced claim on one replica cannot append on the other.
 */
let pg: TestContainer, redis: TestContainer, raw: ReturnType<typeof createDb>;
let a: TestKernel, b: TestKernel;
const providers: ReturnType<typeof spyProvider>[] = [];

const boot = () =>
  startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 6 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );

beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  a = await boot();
  b = await boot();
  raw = createDb(pg.url, 5);
  providers.push(spyProvider(a), spyProvider(b));
});
afterAll(async () => {
  for (const p of providers) p.restore();
  await a?.close();
  await b?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const p of providers) p.calls.length = 0;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.device_instance_bindings, capybara.device_permission_reports, capybara.device_generation_high_water",
  );
});

/** A backend of either replica waits on a lock the other holds (the readiness barrier). */
const lockWaiter = () =>
  waitFor(
    async () => {
      const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(raw);
      return (r.rows[0]?.n ?? 0) > 0;
    },
    10_000,
    "a replica waiting on the other's lock",
  );

/** Holds replica `k`'s next context read inside its open transaction until released. */
function holdRead(k: TestKernel) {
  const entered = gate(),
    release = gate();
  const authority = k.app.get(SandboxOperationAuthority);
  const read = authority.readContextLocked.bind(authority);
  vi.spyOn(authority, "readContextLocked").mockImplementationOnce(async (input, signal) => {
    const payload = await read(input, signal);
    entered.open();
    await release.promise;
    return payload;
  });
  return { entered: entered.promise, release: release.open };
}

const recordOn = (k: TestKernel, f: ContextFixture, claim = f.claim) =>
  recordUnder(k, claim, inputOf(f));

describe("permission context across replicas", () => {
  it("runs on distinct kernels, pools and transaction hosts", () => {
    expect(a.app.get(KernelDb)).not.toBe(b.app.get(KernelDb));
    expect(a.app.get(TransactionHost)).not.toBe(b.app.get(TransactionHost));
  });

  it("two replicas racing from the same predecessor append exactly one snapshot", async () => {
    const f = await seedContext(a, raw);
    const held = holdRead(a);
    const first = recordOn(a, f);
    await held.entered;
    const second = recordOn(b, f);
    await lockWaiter();
    held.release();
    await Promise.all([first, second]);
    const events = await contexts(raw, f.rootId);
    expect(events).toHaveLength(1);
    expect(events[0]?.idemKey.endsWith(":0")).toBe(true);
    for (const p of providers) expect(p.calls).toEqual([]);
  });

  it("the same payload from the other replica appends nothing (no per-process memo)", async () => {
    const f = await seedContext(a, raw);
    await recordOn(a, f);
    await recordOn(b, f);
    await recordOn(a, f);
    expect(await contexts(raw, f.rootId)).toHaveLength(1);
  });

  it("A to B to A across replicas is three snapshots decided from the persisted log", async () => {
    const f = await seedContext(a, raw);
    await recordOn(a, f);
    await b.app.get(PermissionProfilesService).set(f.orgId, f.rootId, f.accountId, {
      profile: "approve-for-me",
      expectedRevision: 0,
    });
    await recordOn(b, f);
    await a.app.get(PermissionProfilesService).set(f.orgId, f.rootId, f.accountId, {
      profile: "request-approval",
      expectedRevision: 1,
    });
    await recordOn(a, f);
    await recordOn(b, f);
    const events = await contexts(raw, f.rootId);
    expect(events.map((e) => e.payload.effectiveProfile)).toEqual([
      "request-approval",
      "approve-for-me",
      "request-approval",
    ]);
    expect(events[2]?.idemKey.endsWith(`:${events[1]?.seq}`)).toBe(true);
  });

  it("a claim replaced on the other replica cannot append, and the new claim can", async () => {
    const f = await seedContext(a, raw);
    const replaced = await b.app.get(RunExecution).claim(f.rootId, f.runId, randomUUID());
    if (!replaced) throw new Error("the run could not be claimed again");
    await expect(recordOn(a, f)).rejects.toBeInstanceOf(ExecutionRevoked);
    expect(await contexts(raw, f.rootId)).toEqual([]);
    await recordOn(b, f, replaced);
    expect(await contexts(raw, f.rootId)).toHaveLength(1);
  });

  it("an authority writer on one replica and the recorder on the other complete in fixed order", async () => {
    const f = await seedContext(a, raw);
    const transitions = b.app.get(PermissionTransitions);
    const original = transitions.recordLocked.bind(transitions);
    const entered = gate(),
      release = gate();
    vi.spyOn(transitions, "recordLocked").mockImplementationOnce(async (...args) => {
      entered.open();
      await release.promise;
      return original(...args);
    });
    const writer = b.app.get(PermissionProfilesService).set(f.orgId, f.rootId, f.accountId, {
      profile: "approve-for-me",
      expectedRevision: 0,
    });
    await entered.promise;
    const recorder = recordOn(a, f);
    await lockWaiter();
    release.open();
    await Promise.all([writer, recorder]);
    expect((await contexts(raw, f.rootId)).map((e) => e.payload.profileRevision)).toEqual([1]);
  });

  it("a run ended by the other replica while the recorder waits appends nothing", async () => {
    const f = await seedContext(a, raw);
    // replica B holds the conversation (a fenced write in progress) while A's recorder waits
    const release = gate(),
      locked = gate();
    const writer = b.app.get(TransactionHost).run(async () => {
      await b.app
        .get(KernelDb)
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", f.rootId)
        .forUpdate()
        .executeTakeFirst();
      locked.open();
      await release.promise;
      await b.app
        .get(KernelDb)
        .updateTable("runs")
        .set({ status: "completed" })
        .where("id", "=", f.runId)
        .execute();
    });
    await locked.promise;
    const recorder = recordOn(a, f);
    await lockWaiter();
    release.open();
    await writer;
    await expect(recorder).rejects.toBeInstanceOf(ExecutionRevoked);
    expect(await contexts(raw, f.rootId)).toEqual([]);
  });

  it("two replicas' managed device writers racing from one predecessor append exactly one marked event", async () => {
    const f = await seedContext(a, raw);
    // the evidence both entries hold for the same installed instance
    const held = {
      deviceId: f.deviceId,
      provider: "@local",
      instanceId: f.deviceId,
      instanceGeneration: f.generation,
      bindingId: f.bindingId,
      roots: ROOTS,
      workingRoot: "/work",
    };
    const writeOn = (k: TestKernel) =>
      k.app.get(RunExecution).withClaim(
        f.claim,
        () => true,
        () =>
          k.app
            .get(ManagedDeviceContextRecorder)
            .record(inputOf(f), held, new AbortController().signal),
      );
    // replica a holds its open transaction after its comparison, before its latest-event read
    const entered = gate(),
      release = gate();
    const facts = a.app.get(PermissionFacts);
    const read = facts.readAppliedEnvironmentLocked.bind(facts);
    vi.spyOn(facts, "readAppliedEnvironmentLocked").mockImplementationOnce(async (input) => {
      const applied = await read(input);
      entered.open();
      await release.promise;
      return applied;
    });
    const first = writeOn(a);
    await entered.promise;
    const second = writeOn(b);
    await lockWaiter();
    release.open();
    await Promise.all([first, second]);
    const rows = await sql<{ idem_key: string; payload: { permissionContextVersion?: number } }>`
      SELECT idem_key, payload FROM capybara.conversation_events
      WHERE conversation_id = ${f.rootId} AND type = 'device_paths'`.execute(raw);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.payload.permissionContextVersion).toBe(1);
    expect(rows.rows[0]?.idem_key.endsWith(":0")).toBe(true);
    for (const p of providers) expect(p.calls).toEqual([]);
  });
});
