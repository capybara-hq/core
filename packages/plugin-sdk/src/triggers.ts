import type { ToolCallContext } from "./tool.js";

/** The value of one fact on a trigger event: filters compare facts, never free text. */
export type TriggerFactValue = string | number | boolean | string[];

/** What an event is about (a task, a document, ...). */
export interface TriggerSubject {
  kind: string;
  id: string;
  title: string;
  url?: string;
}

/**
 * Who caused an event: a tool call of the extension (`call`, the context the kernel passed to the
 * handler), a handle the kernel made from such a call ({@link TriggersCtx.causeOf}; for an event
 * emitted later, from a queue job), or an account acting outside a call.
 */
export type TriggerCause = { call: ToolCallContext } | { handle: string } | { accountId: string };

/** An event an extension emits through `ctx.triggers.emit`. */
export interface TriggerEvent {
  orgId: string;
  /** One of the types the extension declares in `permissions.triggers.emit`. */
  type: string;
  subject: TriggerSubject;
  facts: Record<string, TriggerFactValue>;
  /** Short text for the agent; at most {@link TRIGGER_SUMMARY_MAX_BYTES} UTF-8 bytes. */
  summary: string;
  /** Idempotency key: the same key for the same type and org emits once. */
  dedupeKey: string;
  cause?: TriggerCause;
  /** A directed event: only this agent of this account is woken. */
  audience?: { accountId: string; agentId: string };
}

export interface EventFilterClause {
  fact: string;
  op: "eq" | "in" | "contains";
  value: TriggerFactValue;
}

/** A conjunction: every clause must match. An empty filter matches every event. */
export type EventFilter = EventFilterClause[];

/** `ctx.triggers` (requires `permissions.triggers`). */
export interface TriggersCtx {
  emit(event: TriggerEvent): Promise<{ eventId: string; duplicate: boolean }>;
  /**
   * A serializable cause for an event emitted after the tool call returned: an opaque handle for
   * `call` (the context the kernel passed to the handler) that the kernel binds to the call's org
   * and run and to this extension, valid for 24 hours. Pass it in the `ctx.queue` job's payload
   * and emit with `cause: { handle }`: the event keeps the call's chain depth and self-trigger
   * check. One handle may be used for several events of that org. Throws `TriggerError`
   * (`invalid_event`) for a context the kernel did not make; `emit` refuses an expired handle, or
   * one of another org or extension, the same way.
   */
  causeOf(call: ToolCallContext): Promise<string>;
}

export type TriggerErrorCode = "type_not_declared" | "invalid_event" | "org_disabled";

/** A {@link TriggersCtx} call was refused. */
export class TriggerError extends Error {
  readonly code: TriggerErrorCode;

  constructor(code: TriggerErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "TriggerError";
    this.code = code;
  }
}

export const TRIGGER_SUMMARY_MAX_BYTES = 4096;

/** The shape of a trigger event type name (also the entries of `permissions.triggers.emit`). */
export const TRIGGER_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** Most event types one extension may declare. */
export const TRIGGER_MAX_TYPES = 64;

/**
 * Checks an event before it is stored; returns error codes (empty = valid): `type_not_declared`,
 * `summary_too_long` (UTF-8 bytes), and `missing_<field>` for each empty required field.
 */
export function validateTriggerEvent(e: TriggerEvent, declared: readonly string[]): string[] {
  const errs: string[] = [];
  const blank = (v: unknown): boolean => typeof v !== "string" || v === "";
  if (blank(e.orgId)) errs.push("missing_org_id");
  if (blank(e.type)) errs.push("missing_type");
  else if (!declared.includes(e.type)) errs.push("type_not_declared");
  if (blank(e.subject?.kind)) errs.push("missing_subject_kind");
  if (blank(e.subject?.id)) errs.push("missing_subject_id");
  if (blank(e.subject?.title)) errs.push("missing_subject_title");
  if (blank(e.dedupeKey)) errs.push("missing_dedupe_key");
  if (typeof e.summary !== "string") errs.push("missing_summary");
  else if (new TextEncoder().encode(e.summary).length > TRIGGER_SUMMARY_MAX_BYTES)
    errs.push("summary_too_long");
  return errs;
}

/**
 * Whether the facts satisfy every clause. A missing fact never matches. `eq` compares scalars (an
 * array fact never matches); `in` takes an array value and matches a scalar fact contained in it;
 * `contains` matches an array fact containing the scalar value.
 */
export function matchesFilter(
  filter: EventFilter,
  facts: Record<string, TriggerFactValue>,
): boolean {
  return filter.every((c) => {
    if (!Object.hasOwn(facts, c.fact)) return false;
    const f = facts[c.fact];
    if (f === undefined) return false;
    switch (c.op) {
      case "eq":
        return !Array.isArray(f) && !Array.isArray(c.value) && f === c.value;
      case "in":
        return (
          Array.isArray(c.value) &&
          !Array.isArray(f) &&
          typeof f === "string" &&
          c.value.includes(f)
        );
      case "contains":
        return (
          Array.isArray(f) &&
          !Array.isArray(c.value) &&
          typeof c.value === "string" &&
          f.includes(c.value)
        );
      default:
        return false;
    }
  });
}
