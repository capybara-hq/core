import type { Transaction } from "kysely";
import { type KernelConfig, KernelConfigSchema } from "../../config/schema.js";
import type { KernelDatabase, KernelDb } from "../../db/kernel-schema.js";
import { readSubagentLimitOverride } from "../../identity/settings.js";

/** The sub-agent limits of one parent run (sub-agents spec §8.2). */
export interface SubagentLimits {
  maxConcurrentPerRun: number;
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
  db: KernelDb | Transaction<KernelDatabase>,
  config: () => Pick<KernelConfig, "subagents">,
  orgId: string,
): Promise<SubagentLimits> {
  const base = config().subagents;
  const over = await readSubagentLimitOverride(db, orgId);
  return {
    maxConcurrentPerRun: over?.maxConcurrentPerRun ?? base.maxConcurrentPerRun,
    maxDispatchesPerRun: over?.maxDispatchesPerRun ?? base.maxDispatchesPerRun,
    maxTokensPerRun: over?.maxTokensPerRun ?? base.maxTokensPerRun,
  };
}

/**
 * Whether the sub-agents of `parentRunId` have used their token budget (§8.3): its
 * `subagent_tokens_used`, read fresh, at or over `maxTokensPerRun`. A sub-agent's step checks it
 * before every model request and ends its run with `budget` when it is.
 */
export async function subagentBudgetUsedUp(
  db: KernelDb,
  config: () => Pick<KernelConfig, "subagents">,
  orgId: string,
  parentRunId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("runs")
    .select("subagent_tokens_used")
    .where("id", "=", parentRunId)
    .executeTakeFirst();
  if (!row) return false;
  const { maxTokensPerRun } = await subagentLimits(db, config, orgId);
  return Number(row.subagent_tokens_used) >= maxTokensPerRun;
}
