import { type RawBuilder, sql } from "kysely";
import {
  type AgentDefinition,
  needsLegacyScope,
  normalizeStoredDefinition,
  normalizeToolKeys,
} from "../agents/definition.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelLogger } from "../log.js";
import { LEGACY_BUILTINS, type LegacyScope } from "./legacy-keys.js";

/**
 * Stored release-candidate tool keys (tool naming spec §8): the scope that reads an rc
 * `<x>__<tool>` key in an org, the stored-definition readers that use it, and the startup notice
 * for the rows migration 0063 could not map. No in-process state: each call reads PostgreSQL.
 */

/**
 * What an rc `<x>__<tool>` key can name in `orgId`: the org's live connector slugs and the
 * deployment's extension names (installed ones and config-declared ones, which claim their name
 * in `extension_name_owners`). Migration 0063 reads the same two sources.
 */
export async function loadLegacyScope(db: KernelSchemaDb, orgId: string): Promise<LegacyScope> {
  const [connectors, installs, owners] = await Promise.all([
    db
      .selectFrom("connectors")
      .select("slug")
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .execute(),
    db.selectFrom("extension_installs").select("name").execute(),
    db.selectFrom("extension_name_owners").select("name").execute(),
  ]);
  return {
    connectorSlugs: new Set(connectors.map((r) => r.slug)),
    extensionNames: new Set([...installs, ...owners].map((r) => r.name)),
  };
}

/**
 * A stored agent definition of `orgId` with every rc key it can map read as the current key
 * ({@link normalizeStoredDefinition}); the scope is read only when the definition holds an rc
 * `<x>__<tool>` key.
 */
export async function normalizeStoredDefinitionIn(
  db: KernelSchemaDb,
  orgId: string,
  def: unknown,
): Promise<AgentDefinition> {
  return normalizeStoredDefinition(
    def,
    needsLegacyScope(def) ? await loadLegacyScope(db, orgId) : undefined,
  );
}

/** A stored agent template (or any template-shaped value) of `orgId` in current keys. */
export async function normalizeTemplateIn<T>(db: KernelSchemaDb, orgId: string, t: T): Promise<T> {
  return normalizeToolKeys(
    t,
    needsLegacyScope(t) ? await loadLegacyScope(db, orgId) : undefined,
  ) as T;
}

/**
 * The SQL test for an rc key, the predicate of migration 0063's partial indexes (so the count
 * below reads only those, nearly empty, indexes): an old builtin name, or `<x>__<tool>` not in the
 * current `mcp__` / `plugin__` format.
 */
const legacyKeySql = (col: RawBuilder<unknown>) =>
  sql<boolean>`(${col} = ANY (ARRAY[${sql.join(
    Object.keys(LEGACY_BUILTINS).map((k) => sql.lit(k)),
  )}]::text[]) OR (${col} ~ '^[a-z0-9][a-z0-9_-]*__.' AND ${col} !~ '^(mcp|plugin)__'))`;

/**
 * Rows still holding an rc tool key after migration 0063: grants and pending approvals and
 * questions it could not map (an ambiguous or unknown `<x>__<tool>`). Read-only.
 */
export async function countLegacyToolKeys(db: KernelSchemaDb): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT
      (SELECT count(*) FROM capybara.tool_grants WHERE ${legacyKeySql(sql.ref("tool_key"))})
      + (SELECT count(*) FROM capybara.conversation_tool_grants
         WHERE ${legacyKeySql(sql.ref("tool_key"))})
      + (SELECT count(*) FROM capybara.approvals
         WHERE status = 'pending' AND ${legacyKeySql(sql.ref("tool_key"))})
      + (SELECT count(*) FROM capybara.questions
         WHERE status = 'pending' AND ${legacyKeySql(sql.raw("(spec->>'toolKey')"))})
      AS n
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * The startup notice (spec §8.2): one WARN `tools.legacy_key_unmapped` with the count of rows
 * still holding an rc key, only when there are any. A grant that no longer matches stops applying
 * (the person is asked again), so this is a notice, not a failure.
 */
export async function warnLegacyToolKeys(
  db: KernelSchemaDb,
  log: Pick<KernelLogger, "warn">,
): Promise<void> {
  const count = await countLegacyToolKeys(db);
  if (count > 0) log.warn("tools.legacy_key_unmapped", { count });
}
