import { type Kysely, sql } from "kysely";

/**
 * Why `db.rls: enforce` would filter nothing on this pool, or undefined when it can work (RLS spec
 * §10):
 * - PostgreSQL never applies a row level security policy to a superuser or a role with BYPASSRLS,
 *   even on a table that forces RLS. The official compose file's `POSTGRES_USER` is a superuser, so
 *   such a deployment needs a role of its own before enforcing;
 * - the policies ship dark: migration 0182 creates them without `ENABLE` / `FORCE ROW LEVEL
 *   SECURITY`, which a later migration (phase 5) runs. Until then no org-scoped table applies them.
 */
// biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
export async function rlsEnforceProblem(pool: Kysely<any>): Promise<string | undefined> {
  const role = await sql<{ superuser: boolean; bypass: boolean }>`
    select rolsuper as superuser, rolbypassrls as bypass from pg_roles
    where rolname = current_user`.execute(pool);
  const row = role.rows[0];
  if (row?.superuser) return "the database role is a superuser";
  if (row?.bypass) return "the database role has BYPASSRLS";
  const off = await sql<{ table: string }>`
    select c.relname as table from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'capybara'
    where c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)
      and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    order by 1`.execute(pool);
  if (off.rows.length > 0) {
    const first = off.rows[0]?.table;
    return `row level security is not enabled and forced on ${off.rows.length} org-scoped table(s) (${first}, …; RLS spec phase 5 enables them)`;
  }
  return undefined;
}
