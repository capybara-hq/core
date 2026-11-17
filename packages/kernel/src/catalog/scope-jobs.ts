import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";

/**
 * The plugin scope sync's jobs as the outbox owes them (transactional outbox spec §8.1): a leaf
 * module (type imports only), so the import confirm (`PluginImport`, below the scope service), the
 * extension host's deploy (`ExtensionAdminOps`, `ExtensionAdmin`) and the CLI owe them without the
 * sync. `scope-sync.ts` (the consumer side) re-exports these names.
 */

/** The scope sync queue (no `:` in the name). */
export const PLUGIN_SCOPE_QUEUE = "cap-kernel-plugin-scope";
/** The job fanning one item out to every org: one {@link SCOPE_CHUNK_JOB} per org chunk. */
export const SCOPE_ITEM_JOB = "scope-item";
/** The job converging one item in one chunk of orgs (at most {@link SCOPE_ORG_CHUNK} of them). */
export const SCOPE_CHUNK_JOB = "scope-item-chunk";
/** The job converging every item in one org. */
export const SCOPE_ORG_JOB = "scope-org";
/** How many orgs one chunk job converges. */
export const SCOPE_ORG_CHUNK = 100;
/**
 * Optional provider (a test seam): the chunk size instead of {@link SCOPE_ORG_CHUNK}, so a test
 * with a few orgs fans out to several chunks.
 */
export const SCOPE_ORG_CHUNK_SIZE = Symbol("SCOPE_ORG_CHUNK_SIZE");

/**
 * One item job per owing transaction (`xact`: its PostgreSQL transaction id, so two owes in one
 * transaction are one job, and a later transaction's job is never swallowed by an earlier one
 * still running; no `:`: item ids are UUIDs).
 */
export const scopeItemJobId = (itemId: string, xact: string): string =>
  `scope-item-${itemId}-x${xact}`;
/** Chunk `n` of an item job (deterministic: a redelivered item job adds the same chunks). */
export const scopeChunkJobId = (itemJobId: string, n: number): string => `${itemJobId}-c${n}`;
/** One org job at a time per org. */
export const scopeOrgJobId = (orgId: string): string => `scope-org-${orgId}`;

/** The job's data. */
export type ScopeJob =
  | { kind: "item"; itemId: string }
  | { kind: "chunk"; itemId: string; orgIds: string[] }
  | { kind: "org"; orgId: string };

/** The id of the transaction in context (assigned now if it has none yet). */
async function currentXact(db: KernelSchemaDb): Promise<string> {
  const r = await sql<{ xact: string }>`SELECT pg_current_xact_id()::text AS xact`.execute(db);
  const xact = r.rows[0]?.xact;
  if (xact === undefined) throw new Error("no transaction id");
  return xact;
}

/**
 * Owes the item's scope sync in the transaction in context, one job per transaction (see
 * {@link scopeItemJobId}). A missing item owes nothing.
 */
export async function oweScopeItem(
  outbox: Pick<OutboxService, "add">,
  db: KernelSchemaDb,
  itemId: string,
): Promise<void> {
  const row = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row) return;
  await outbox.add<ScopeJob>({
    queue: PLUGIN_SCOPE_QUEUE,
    name: SCOPE_ITEM_JOB,
    jobId: scopeItemJobId(itemId, await currentXact(db)),
    data: { kind: "item", itemId },
  });
}

/**
 * Owes the scope sync of the live catalog item of an extension (its plugin, by name; at most one
 * live item has a name) in the transaction that deploys it: the extension became enabled, a new
 * version of an enabled one was installed, or its permissions were approved while enabled (or
 * config-declared). The sync then installs it where its scope wants it on; a replica that has not
 * loaded the extension yet fails the chunk job, and BullMQ retries it. A builtin item (on
 * everywhere through its required extension) owes nothing.
 */
export async function oweDeployedExtensionSync(
  outbox: Pick<OutboxService, "add">,
  db: KernelSchemaDb,
  extensionName: string,
): Promise<void> {
  const item = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("name", "=", extensionName)
    .where("deleted_at", "is", null)
    .where("builtin", "=", false)
    .executeTakeFirst();
  if (item) await oweScopeItem(outbox, db, item.id);
}
