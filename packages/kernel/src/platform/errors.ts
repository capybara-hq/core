import { ToolError } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import type { ActorFacts } from "./actor.js";
import type { OperationError, OperationErrorNext } from "./operation.js";

/** Longest `details` JSON quoted in an operation's tool error. */
const DETAILS_MAX = 1000;

/** What the model is told to do after an operation refused its input (Platform tool spec §5.2). */
export const OPERATION_ERROR_NEXT =
  "Check the input with describe and call again, or ask the person.";

/** The role an error's next step is written for (spec §14.5 item 7). */
export type ErrorRole = "superAdmin" | "orgAdmin" | "member";

/** The actor's role for next steps: the super admin first, then an org admin (admin or owner). */
export function errorRoleOf(facts: Pick<ActorFacts, "role" | "isSuperAdmin">): ErrorRole {
  if (facts.isSuperAdmin) return "superAdmin";
  return facts.role === "admin" || facts.role === "owner" ? "orgAdmin" : "member";
}

/**
 * Which keyed texts a role may get, in order. The super admin's text (the admin console path) goes
 * to the super admin only; an org admin falls back to the member's step and a member to the org
 * admin's (both name steps inside the org).
 */
const FALLBACK: Record<ErrorRole, readonly ErrorRole[]> = {
  superAdmin: ["superAdmin", "orgAdmin", "member"],
  orgAdmin: ["orgAdmin", "member"],
  member: ["member", "orgAdmin"],
};

/** The next step an operation declares for `code`, for this role; undefined when it has none. */
export function nextStepFor(
  errors: readonly OperationError[] | undefined,
  code: string,
  role: ErrorRole,
): string | undefined {
  return resolveNext(errors?.find((e) => e.code === code)?.next, role);
}

/** One next step resolved for this role (the fallbacks of {@link nextStepFor}). */
export function resolveNext(
  next: OperationErrorNext | undefined,
  role: ErrorRole,
): string | undefined {
  if (next === undefined || typeof next === "string") return next;
  for (const r of FALLBACK[role]) {
    const text = next[r];
    if (text !== undefined) return text;
  }
  return undefined;
}

/** `errors[]` as `describe` shows them to this actor: each `next` resolved for the role. */
export function errorsFor(
  errors: readonly OperationError[],
  role: ErrorRole,
): { code: string; next: string }[] {
  return errors.flatMap((e) => {
    const next = nextStepFor(errors, e.code, role);
    return next === undefined ? [] : [{ code: e.code, next }];
  });
}

/**
 * An error an operation threw, as the `Platform` tool's error for the model (spec §5.2: errors say
 * what to do next). A `ToolError` passes as is; an `ApiError` (what the same HTTP route would
 * answer) keeps its code, message and details, then gives the next step: `nextOf(code)` (the
 * operation's entry for the actor's role), else the generic one. Anything else is a kernel fault,
 * not the model's: it is rethrown, so the pipeline logs it and reports the generic failure.
 */
export function toToolError(e: unknown, nextOf?: (code: string) => string | undefined): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof ApiError) {
    const details =
      e.details !== undefined && e.details.length > 0
        ? ` Details: ${clip(JSON.stringify(e.details))}`
        : "";
    return new ToolError(
      `${e.code}: ${sentence(e.message)}${details} ${nextOf?.(e.code) ?? OPERATION_ERROR_NEXT}`,
    );
  }
  throw e;
}

/** A text ending with a full stop (`.` added unless it ends with `.`, `!` or `?`). */
export const sentence = (s: string): string => s.trim().replace(/[.!?]?$/, (m) => m || ".");

const clip = (s: string): string => (s.length > DETAILS_MAX ? `${s.slice(0, DETAILS_MAX)}…` : s);
