import { ToolError } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";

/** Longest `details` JSON quoted in an operation's tool error. */
const DETAILS_MAX = 1000;

/** What the model is told to do after an operation refused its input (Platform tool spec §5.2). */
export const OPERATION_ERROR_NEXT =
  "Check the input with describe and call again, or ask the person.";

/**
 * An error an operation threw, as the `Platform` tool's error for the model (spec §5.2: errors say
 * what to do next). A `ToolError` passes as is; an `ApiError` (what the same HTTP route would
 * answer) keeps its code, message and details, then says what to do next. Anything else is a
 * kernel fault, not the model's: it is rethrown, so the pipeline logs it and reports the generic
 * failure.
 */
export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof ApiError) {
    const details =
      e.details !== undefined && e.details.length > 0
        ? ` Details: ${clip(JSON.stringify(e.details))}`
        : "";
    const message = e.message.trim().replace(/[.!]?$/, ".");
    return new ToolError(`${e.code}: ${message}${details} ${OPERATION_ERROR_NEXT}`);
  }
  throw e;
}

const clip = (s: string): string => (s.length > DETAILS_MAX ? `${s.slice(0, DETAILS_MAX)}…` : s);
