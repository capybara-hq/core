import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";

/**
 * The plugin scope sync's jobs as the outbox owes them (transactional outbox spec §8.1): a leaf
 * module (type imports only), so the import confirm (`PluginImport`, below the scope service) and
 * the CLI owe them without the sync. `scope-sync.ts` (the consumer side) re-exports these names.
 */

/** The scope sync queue (no `:` in the name). */
export const PLUGIN_SCOPE_QUEUE = "cap-kernel-plugin-scope";
/** The job converging one item in every org. */
export const SCOPE_ITEM_JOB = "scope-item";
/** The job converging every item in one org. */
export const SCOPE_ORG_JOB = "scope-org";
/**
 * The delayed backstop of an item job owed by a confirmation's commit (ruling R24): it converges
 * the item as {@link SCOPE_ITEM_JOB} does once the extension is deployed, and fails (BullMQ
 * retries it with its backoff) while the extension is not enabled on the deployment yet.
 */
export const SCOPE_BACKSTOP_JOB = "scope-item-backstop";
/** How long after the confirmation's commit the backstop runs (the deploy has finished by then). */
export const SCOPE_BACKSTOP_DELAY_MS = 5 * 60_000;

/** One item job per scope version (no `:`: item ids are UUIDs). */
export const scopeItemJobId = (itemId: string, version: number): string =>
  `scope-item-${itemId}-${version}`;
/** The backstop of the item job of a scope version (distinct from the immediate one). */
export const scopeBackstopJobId = (itemId: string, version: number): string =>
  `${scopeItemJobId(itemId, version)}-backstop`;
/** One org job at a time per org. */
export const scopeOrgJobId = (orgId: string): string => `scope-org-${orgId}`;
/**
 * The delayed retry `n` of an item job whose extension this replica had not loaded yet (ruling
 * P3-38); deterministic, so replicas deferring the same item add it once.
 */
export const scopeRetryJobId = (itemId: string, version: number, n: number): string =>
  `scope-item-${itemId}-${version}-r${n}`;

/**
 * The job's data. `retry`: the item job's delayed retry number (P3-38). `backstop`: a
 * {@link SCOPE_BACKSTOP_JOB}.
 */
export type ScopeJob =
  | { kind: "item"; itemId: string; retry?: number; backstop?: true }
  | { kind: "org"; orgId: string };

/**
 * Owes the item's scope sync in the transaction in context, once per scope version (read in that
 * transaction, so after its own bump); `backstop` owes the delayed backstop instead. A missing item
 * owes nothing.
 */
export async function oweScopeItem(
  outbox: Pick<OutboxService, "add">,
  db: KernelSchemaDb,
  itemId: string,
  opts: { backstop?: boolean } = {},
): Promise<void> {
  const row = await db
    .selectFrom("catalog_items")
    .select("scope_version")
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row) return;
  if (opts.backstop === true) {
    await outbox.add<ScopeJob>({
      queue: PLUGIN_SCOPE_QUEUE,
      name: SCOPE_BACKSTOP_JOB,
      jobId: scopeBackstopJobId(itemId, row.scope_version),
      data: { kind: "item", itemId, backstop: true },
      runAt: new Date(Date.now() + SCOPE_BACKSTOP_DELAY_MS),
    });
    return;
  }
  await outbox.add<ScopeJob>({
    queue: PLUGIN_SCOPE_QUEUE,
    name: SCOPE_ITEM_JOB,
    jobId: scopeItemJobId(itemId, row.scope_version),
    data: { kind: "item", itemId },
  });
}
