import type { Kysely } from "kysely";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelDatabase } from "../db/kernel-schema.js";

/**
 * The model and effort a person chose for a conversation (UI refresh B, spec §5.2): `null` model =
 * the agent's model, `null` effort = the agent's saved effort or the model's default. Recorded in
 * the log as `model_switched` events (the source of truth) and cached in `conversations.selection`
 * for the conversation view.
 */
export interface Selection {
  model: ModelRef | null;
  effort: string | null;
}

export const NO_SELECTION: Selection = { model: null, effort: null };

export const sameModel = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

export const sameSelection = (a: Selection, b: Selection): boolean =>
  a.effort === b.effort &&
  (a.model === null || b.model === null ? a.model === b.model : sameModel(a.model, b.model));

/**
 * The selection a message's pick switches to, or null when it changes nothing (pure; the direct
 * send and queue dispatch share it). A model equal to the agent's means "back to the agent's
 * model" (null); a model change without `effort` resets the effort.
 */
export function planSelection(
  agentModel: ModelRef,
  current: Selection,
  pick: { model?: ModelRef | undefined; effort?: string | undefined },
): Selection | null {
  if (pick.model === undefined && pick.effort === undefined) return null;
  const model =
    pick.model === undefined
      ? current.model
      : sameModel(pick.model, agentModel)
        ? null
        : { provider: pick.model.provider, model: pick.model.model };
  const modelChanged = !sameSelection(
    { model, effort: null },
    { model: current.model, effort: null },
  );
  const effort = pick.effort ?? (modelChanged ? null : current.effort);
  const next: Selection = { model, effort };
  return sameSelection(next, current) ? null : next;
}

/**
 * The selection in effect for a run that started at `seq` (its `run_started`): the latest
 * `model_switched` before it. Runtime and replays read it the same way, so a replay honors the
 * switch the original run used.
 */
export function selectionAt(
  events: readonly { seq: number; type: string; payload: unknown }[],
  seq: number,
): Selection {
  let out = NO_SELECTION;
  for (const e of events) {
    if (e.seq >= seq) break;
    if (e.type === "model_switched") {
      const p = e.payload as { model: ModelRef | null; effort: string | null };
      out = { model: p.model, effort: p.effort };
    }
  }
  return out;
}

/**
 * The definition a run uses under a selection: `model` replaced by the selected one, `modelParams`
 * = the agent's own (only while the model is the agent's) plus the selected effort. Fallback model
 * and params are untouched. No selection returns the definition itself (old logs stay identical).
 */
export function effectiveDefinition(def: AgentDefinition, sel: Selection): AgentDefinition {
  if (sel.model === null && sel.effort === null) return def;
  const model = sel.model ?? def.model;
  const own = sameModel(model, def.model) ? (def.modelParams ?? {}) : {};
  return {
    ...def,
    model,
    modelParams: { ...own, ...(sel.effort !== null && { effort: sel.effort }) },
  };
}

/**
 * The selection from the log: the latest `model_switched` (before `beforeSeq` when given). Pass a
 * transaction that holds the conversation row lock to read it consistently with an append.
 */
export async function readSelection(
  db: Kysely<KernelDatabase>,
  conversationId: string,
  beforeSeq?: number,
): Promise<Selection> {
  let q = db
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "model_switched")
    .orderBy("seq", "desc")
    .limit(1);
  if (beforeSeq !== undefined) q = q.where("seq", "<", String(beforeSeq));
  const row = await q.executeTakeFirst();
  if (!row) return NO_SELECTION;
  const p = row.payload as { model: ModelRef | null; effort: string | null };
  return { model: p.model, effort: p.effort };
}
