import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0055_subagent_parent_indexes.sql (final review I2): the `ON DELETE CASCADE` of
 * `conversations.parent_conversation_id` and of `subagent_dispatches.parent_conversation_id` runs
 * `… WHERE $1 = parent_conversation_id` with no `kind` predicate, so it needs indexes without one.
 */
const FILE = "0055_subagent_parent_indexes.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 1);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 120_000);

/** The generic plan of the statement the cascade runs (seq scans priced out). */
async function cascadePlan(table: string): Promise<string> {
  return db.connection().execute(async (c) => {
    await sql`set enable_seqscan = off`.execute(c);
    await sql`set plan_cache_mode = force_generic_plan`.execute(c);
    await sql
      .raw(`prepare cascade_${table}(text) as
        delete from capybara.${table} where $1 = parent_conversation_id`)
      .execute(c);
    const rows = await sql<{ "QUERY PLAN": string }>`${sql.raw(
      `explain execute cascade_${table}('p1')`,
    )}`.execute(c);
    await sql.raw(`deallocate cascade_${table}`).execute(c);
    await sql`reset enable_seqscan`.execute(c);
    await sql`reset plan_cache_mode`.execute(c);
    return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

describe("0055_subagent_parent_indexes", () => {
  it("the parent cascades of conversations and subagent_dispatches use an index", async () => {
    expect(await cascadePlan("conversations")).toContain("conversations_parent_conv_idx");
    expect(await cascadePlan("subagent_dispatches")).toContain(
      "subagent_dispatches_parent_conv_idx",
    );
  });

  it("applies twice without error", async () => {
    const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (t) => {
      await sql`set local search_path to capybara, public`.execute(t);
      await sql.raw(content).execute(t);
    });
  });
});
