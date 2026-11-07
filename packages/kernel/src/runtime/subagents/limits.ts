import { type KernelConfig, KernelConfigSchema } from "../../config/schema.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { readSubagentLimitOverride } from "../../identity/settings.js";

/** The config the limits read (`KernelConfigService`, live: `subagents.*` is hot). */
export interface SubagentsConfig {
  get(): Pick<KernelConfig, "subagents">;
}

/**
 * The sub-agent limits of an organization (sub-agents spec §8.2, agent map spec §6): the depth
 * below the root, the active children of one conversation, and the dispatches and tokens of one
 * tree, counted on its budget run ({@link budgetRunOf}). `maxDispatchesPerRun` and
 * `maxTokensPerRun` of 0 mean no limit.
 */
export interface SubagentLimits {
  maxDepth: number;
  maxConcurrentPerConversation: number;
  maxDispatchesPerRun: number;
  maxTokensPerRun: number;
}

/** The `subagents.*` defaults of the config schema. */
export const SUBAGENT_LIMIT_DEFAULTS: SubagentLimits =
  KernelConfigSchema.shape.subagents.parse(undefined);

/**
 * The sub-agent limits for an organization: its entry in the deployment setting
 * `subagentLimitOverrides`, value by value, over the hot config `subagents.*`. Read live (no cache),
 * in the caller's transaction when one is given, so every replica applies a change at once.
 */
export async function subagentLimits(
  /** The pool, or the context's handle (a `@Transactional` caller's transaction). */
  db: KernelSchemaDb,
  config: SubagentsConfig,
  orgId: string,
): Promise<SubagentLimits> {
  const base = config.get().subagents;
  const over = await readSubagentLimitOverride(db, orgId);
  return {
    maxDepth: over?.maxDepth ?? base.maxDepth,
    maxConcurrentPerConversation:
      over?.maxConcurrentPerConversation ?? base.maxConcurrentPerConversation,
    maxDispatchesPerRun: over?.maxDispatchesPerRun ?? base.maxDispatchesPerRun,
    maxTokensPerRun: over?.maxTokensPerRun ?? base.maxTokensPerRun,
  };
}

/**
 * The budget run of `runId` (agent map spec §6): its `budget_run_id`, or the run itself when it has
 * none (a person-triggered run opens its own window) or does not exist. The dispatch count and the
 * token counter of a whole tree live on this run.
 */
export async function budgetRunOf(db: KernelSchemaDb, runId: string): Promise<string> {
  const row = await db
    .selectFrom("runs")
    .select("budget_run_id")
    .where("id", "=", runId)
    .executeTakeFirst();
  return row?.budget_run_id ?? runId;
}

/**
 * The current budget window of the tree rooted at `rootConversationId` (agent map spec §6): its
 * newest run that opened its own window (`budget_run_id` null: a person-triggered run), or null
 * when it has none. A wake run of any conversation of the tree carries it as its `budget_run_id`,
 * so a chain of wakes never opens a new window.
 */
export async function budgetWindowOf(
  db: KernelSchemaDb,
  rootConversationId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", rootConversationId)
    .where("budget_run_id", "is", null)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Whether the sub-agents of a tree have used their token budget (§8.3): the budget run's
 * `subagent_tokens_used`, read fresh, at or over `maxTokensPerRun` (never when it is 0: no limit). A sub-agent's step checks it
 * before every model request and ends its run with `budget` when it is.
 */
export async function subagentBudgetUsedUp(
  db: KernelSchemaDb,
  config: SubagentsConfig,
  orgId: string,
  budgetRunId: string,
): Promise<boolean> {
  const { maxTokensPerRun } = await subagentLimits(db, config, orgId);
  // 0: no limit
  if (maxTokensPerRun === 0) return false;
  const row = await db
    .selectFrom("runs")
    .select("subagent_tokens_used")
    .where("id", "=", budgetRunId)
    .executeTakeFirst();
  if (!row) return false;
  return Number(row.subagent_tokens_used) >= maxTokensPerRun;
}
