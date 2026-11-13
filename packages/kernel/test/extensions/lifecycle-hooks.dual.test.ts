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
import { LIFECYCLE_QUEUE, lifecycleJobId } from "../../src/extensions/lifecycle-hooks.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, runConfig, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Lifecycle hooks across two replicas: replica A (api only) cannot add to the lifecycle queue (the
 * outbox's `OUTBOX_DISPATCH_FAILS` seam, a Redis outage on A), so a member removed there is not
 * delivered by A's fast path; the row stays owed and B's outbox relay delivers it, exactly once.
 */

const PLUGIN = "fake-lifecycle";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let a: TestKernel;
let b: TestKernel;

const config = (roles: ("api" | "worker")[]) =>
  runConfig(
    { pg: pgc.url, redis: rd.url },
    { roles, extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
  );

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // A runs only the api role: no relay of its own competes with B's (a failed pass of A's would
  // push the row's backoff out), as in test/infra/outbox.dispatcher.test.ts's relay section
  a = await startKernel(config(["api"]), {
    overrides: [
      { provide: OUTBOX_DISPATCH_FAILS, useValue: (queue: string) => queue === LIFECYCLE_QUEUE },
    ],
  });
  b = await startKernel(config(["api", "worker"]));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await Promise.all([a?.close().catch(() => {}), b?.close().catch(() => {})]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("lifecycle hooks across two replicas", () => {
  it("a delivery A cannot add is owed until B's relay delivers it, exactly once", async () => {
    const accounts = a.app.get(AccountsService);
    const owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
    const member = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
    const org = await a.app.get(OrgsService).create({ name: "Dual" }, owner);
    const members = a.app.get(MembersService);
    await members.add(org.id, member.id, "member", owner.id);
    await members.remove(org.id, member.id, owner.id);
    const payload = { orgId: org.id, accountId: member.id };
    const json = JSON.stringify(payload);
    const jobId = lifecycleJobId("org.member_removed", PLUGIN, payload);
    const owed = async () =>
      (
        await db
          .selectFrom("outbox")
          .select("id")
          .where("queue", "=", LIFECYCLE_QUEUE)
          .where("job_id", "=", jobId)
          .execute()
      ).length;
    const count = async (table: "calls" | "deliveries") =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(
            `plugin_fake_lifecycle.${table}`,
          )} WHERE payload = ${json}::jsonb`.execute(raw)
        ).rows[0]?.n,
      );
    await waitFor(async () => (await count("deliveries")) === 1, 30_000, "delivered by B's relay");
    await waitFor(async () => (await owed()) === 0, 10_000, "outbox row gone");
    // nothing-happened window: the second replica must not deliver the job again
    await new Promise((r) => setTimeout(r, 1500));
    expect(await count("calls")).toBe(1);
    expect(await count("deliveries")).toBe(1);
  });
});
