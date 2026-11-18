import { withoutRunContext } from "./run-context.js";

/**
 * Test helpers for the recorded permission context (permission context replay spec B2): on the
 * activated tree every run records one before its first request, rendered as a system message.
 * Tests about other request contents leave it out, as they leave the run context out.
 */

/** Whether a system message is a rendered permission context. */
export const isPermissionContextText = (text: string): boolean =>
  text.startsWith("Permission context for new operations:");

/** A captured request without its permission context system messages. */
export function withoutPermissionContext<
  R extends { messages: readonly { role: string; content: unknown }[] },
>(req: R): R {
  return {
    ...req,
    messages: req.messages.filter(
      (m) =>
        !(
          m.role === "system" &&
          typeof m.content === "string" &&
          isPermissionContextText(m.content)
        ),
    ),
  };
}

/** A captured request without its run context and its permission context. */
export function withoutRunPreamble<
  R extends { messages: readonly { role: string; content: unknown }[] },
>(req: R): R {
  return withoutPermissionContext(withoutRunContext(req));
}
