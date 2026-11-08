import { ApiError } from "../../errors.js";
import type { PrecheckResult } from "../operation.js";

/**
 * An operation's precheck from a service read that throws the write's own refusal: the
 * {@link ApiError} it throws becomes the failure (its code and message), a return passes. Anything
 * else propagates, and the tool skips the precheck.
 */
export async function precheckBy(read: () => Promise<unknown>): Promise<PrecheckResult> {
  try {
    await read();
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
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
