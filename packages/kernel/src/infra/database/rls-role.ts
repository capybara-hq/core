import { type Kysely, sql } from "kysely";

/**
 * Why `db.rls: enforce` cannot work on this pool's role, or undefined when it can: PostgreSQL never
 * applies a row level security policy to a superuser or a role with BYPASSRLS, even on a table that
 * forces RLS (RLS spec §10). The official compose file's `POSTGRES_USER` is a superuser, so such a
 * deployment needs a role of its own before enforcing.
 */
// biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
export async function rlsBypassReason(pool: Kysely<any>): Promise<string | undefined> {
  const r = await sql<{ superuser: boolean; bypass: boolean }>`
    select rolsuper as superuser, rolbypassrls as bypass from pg_roles
    where rolname = current_user`.execute(pool);
  const row = r.rows[0];
  if (row?.superuser) return "the database role is a superuser";
  if (row?.bypass) return "the database role has BYPASSRLS";
  return undefined;
}
