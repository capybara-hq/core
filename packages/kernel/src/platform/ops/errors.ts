import { ToolError } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../errors.js";

/**
 * Runs a service call for an operation: an {@link ApiError} (the service's refusal: forbidden,
 * not found, a stale preview) becomes a {@link ToolError} naming its code, so the model reads what
 * to do next instead of a generic failure. Anything else is a bug and propagates.
 */
export async function asToolError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError) {
      throw new ToolError(`${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/** The audit detail of a write made through the tool (spec §6): who, where and which operation. */
export function viaAgent(
  operation: string,
  ctx: { conversationId: string; runId: string | null },
): Record<string, unknown> {
  return { via: "agent", conversationId: ctx.conversationId, runId: ctx.runId, operation };
}
