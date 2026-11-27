import { createHash } from "node:crypto";
import type {
  EventFilter,
  TriggerEventDeclaration,
  TriggerFactDeclaration,
  TriggerSubject,
} from "@capybara-hq/plugin-sdk";

/**
 * A window whose first delivery waits this long past its coalescing window is taken as lost (its
 * job failed for good): the next event of the pair opens a new window with a job of its own, and
 * the trigger event sweep owes a job for a window no event comes to (`TriggerEventSweepJob`).
 */
export const COALESCE_STALE_MS = 10 * 60_000;

/** A stable, BullMQ-safe key for a trigger subject: `${kind}-${sha1(id).slice(0, 16)}`. */
export function subjectKey(s: TriggerSubject): string {
  const digest = createHash("sha1").update(s.id).digest("hex").slice(0, 16);
  return `${s.kind.replaceAll(":", "-")}-${digest}`;
}

/** Deterministic job id for coalescing events of one subject into one automation run. */
export function coalesceJobId(automationId: string, s: TriggerSubject): string {
  return coalesceJobIdOfKey(automationId, subjectKey(s));
}

/** {@link coalesceJobId} from the subject's stored key ({@link subjectKey}). */
export function coalesceJobIdOfKey(automationId: string, key: string): string {
  return `automation-coalesce-${automationId.replaceAll(":", "-")}-${key}`;
}

/** True when the event was caused by a run of this same automation account and agent. */
export function isSelfTriggered(
  a: { accountId: string; agentId: string },
  cause: { runAccountId: string; runAgentId: string } | null,
): boolean {
  return cause !== null && cause.runAccountId === a.accountId && cause.runAgentId === a.agentId;
}

export function depthExceeded(depth: number, max: number): boolean {
  return depth > max;
}

/** The most clauses an event automation's filter may have. */
export const FILTER_MAX_CLAUSES = 20;

const isScalarOf = (type: TriggerFactDeclaration["type"], v: unknown): boolean =>
  type !== "string[]" && typeof v === type;

/**
 * Why `filter` cannot be saved for events of the declared types `decls` (the declarations of every
 * type the automation selects); an empty list means it can. Each clause's fact must exist in every
 * selected type, be `filterable`, and the operator and value must fit the fact's type: `eq` takes
 * a scalar of the fact's type, `in` a string list on a string fact, `contains` a string on a
 * string-list fact.
 */
export function validateFilter(filter: EventFilter, decls: TriggerEventDeclaration[]): string[] {
  const errors: string[] = [];
  if (filter.length > FILTER_MAX_CLAUSES) {
    errors.push(`A filter has at most ${FILTER_MAX_CLAUSES} clauses`);
  }
  for (const c of filter) {
    const facts = decls.map((d) => ({
      type: d.type,
      fact: Object.hasOwn(d.facts, c.fact) ? d.facts[c.fact] : undefined,
    }));
    const missing = facts.filter((f) => f.fact === undefined);
    if (decls.length === 0 || missing.length > 0) {
      const where = missing.map((m) => m.type).join(", ");
      errors.push(
        `Fact "${c.fact}" is not declared by ${where === "" ? "the selected event types" : where}`,
      );
      continue;
    }
    const declared = facts.map((f) => f.fact as TriggerFactDeclaration);
    if (declared.some((f) => !f.filterable)) {
      errors.push(`Fact "${c.fact}" cannot be filtered on`);
      continue;
    }
    const kinds = new Set(declared.map((f) => f.type));
    if (kinds.size > 1) {
      errors.push(`Fact "${c.fact}" has different types in the selected event types`);
      continue;
    }
    const type = declared[0]?.type as TriggerFactDeclaration["type"];
    if (c.op === "eq") {
      if (!isScalarOf(type, c.value)) {
        errors.push(
          type === "string[]"
            ? `Fact "${c.fact}" is a list: use "contains" with a string`
            : `Operator "eq" on fact "${c.fact}" needs a ${type} value`,
        );
      }
    } else if (c.op === "in") {
      const ok =
        type === "string" && Array.isArray(c.value) && c.value.every((v) => typeof v === "string");
      if (!ok)
        errors.push(`Operator "in" on fact "${c.fact}" needs a list of strings on a string fact`);
    } else if (c.op === "contains") {
      if (type !== "string[]" || typeof c.value !== "string") {
        errors.push(`Operator "contains" on fact "${c.fact}" needs a string on a string-list fact`);
      }
    } else {
      errors.push(`Operator "${String(c.op)}" is not supported`);
    }
  }
  return errors;
}
