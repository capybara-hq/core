import { type Kysely, sql } from "kysely";

/**
 * Turns the dark RLS policies on, as phase 5's migration will (RLS spec §10): `ENABLE` and `FORCE
 * ROW LEVEL SECURITY` on every `capybara` table with an `org_id` column. Test-only: the shipped
 * migration (0182) creates the policies without enabling them. Run it as the tables' owner.
 */
// biome-ignore lint/suspicious/noExplicitAny: raw pools carry no schema types
export async function enableRlsForTest(db: Kysely<any>): Promise<string[]> {
  const r = await sql<{ table: string }>`
    select c.relname as table from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'capybara'
    where c.relkind = 'r' and exists (select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    order by 1`.execute(db);
  for (const { table } of r.rows) {
    await sql
      .raw(
        `ALTER TABLE capybara."${table}" ENABLE ROW LEVEL SECURITY; ` +
          `ALTER TABLE capybara."${table}" FORCE ROW LEVEL SECURITY`,
      )
      .execute(db);
  }
  return r.rows.map((x) => x.table);
}
