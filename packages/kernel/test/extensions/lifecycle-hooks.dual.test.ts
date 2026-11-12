import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LIFECYCLE_DELIVERY_HOOKS, LifecycleHooks } from "../../src/extensions/lifecycle-hooks.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, runConfig, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Lifecycle hooks across two replicas: replica A drops its enqueues on purpose (test seam), so a
 * member removed there is delivered only by the sweeper; both replicas sweep at once, and the
 * delivery happens exactly once (the job id dedupes the two offers; a delivered row is skipped).
 */

const PLUGIN = "fake-lifecycle";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let a: TestKernel;
let b: TestKernel;

const config = () =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    { roles: ["api", "worker"], extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
  );

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  a = await startKernel(config(), {
    overrides: [{ provide: LIFECYCLE_DELIVERY_HOOKS, useValue: { dropEnqueue: true } }],
  });
  b = await startKernel(config());
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
}, 180_000);

afterAll(async () => {
  await Promise.all([a?.close().catch(() => {}), b?.close().catch(() => {})]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("lifecycle hooks across two replicas", { timeout: 60_000 }, () => {
  it("an enqueue dropped on purpose is delivered by the sweeper exactly once", async () => {
    const accounts = a.app.get(AccountsService);
    const owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
    const member = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
    const org = await a.app.get(OrgsService).create({ name: "Dual" }, owner);
    const members = a.app.get(MembersService);
    await members.add(org.id, member.id, "member", owner.id);
    await members.remove(org.id, member.id, owner.id);
    const payload = JSON.stringify({ orgId: org.id, accountId: member.id });
    const rows = () =>
      db
        .selectFrom("lifecycle_deliveries")
        .selectAll()
        .where("mount", "=", "org.member_removed")
        .where(sql<boolean>`payload = ${payload}::jsonb`)
        .execute();
    const calls = async () =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*) AS n FROM plugin_fake_lifecycle.calls
            WHERE payload = ${payload}::jsonb`.execute(raw)
        ).rows[0]?.n,
      );
    expect(await rows()).toHaveLength(1);
    // nothing was enqueued: no delivery happens on its own
    await new Promise((r) => setTimeout(r, 1500));
    expect((await rows())[0]?.delivered_at).toBeNull();
    expect(await calls()).toBe(0);
    // too young for the sweeper (30 s): backdate it, then both replicas sweep at once
    await db
      .updateTable("lifecycle_deliveries")
      .set({ created_at: sql<Date>`now() - interval '1 minute'` as unknown as Date })
      .where(sql<boolean>`payload = ${payload}::jsonb`)
      .execute();
    await Promise.all([a, b].map((k) => k.app.get(LifecycleHooks).sweep()));
    await waitFor(
      async () => (await rows())[0]?.delivered_at != null,
      15_000,
      "delivered by the sweeper",
    );
    // a second sweep finds nothing to offer, and the handler ran once
    await Promise.all([a, b].map((k) => k.app.get(LifecycleHooks).sweep()));
    await new Promise((r) => setTimeout(r, 1000));
    expect(await calls()).toBe(1);
    const delivered = await sql<{ n: string }>`SELECT count(*) AS n
      FROM plugin_fake_lifecycle.deliveries WHERE payload = ${payload}::jsonb`.execute(raw);
    expect(Number(delivered.rows[0]?.n)).toBe(1);
    expect((await rows())[0]?.attempts).toBe(1);
  });
});
