import type { ContentBlock } from "@capybara-hq/plugin-sdk";

/**
 * Test helpers for the run context (spec 2026-11-08-run-context-design): tests about other
 * request contents leave the snapshots and the sender line out.
 */

/** Whether a system message is a run context snapshot (first or update). */
export const isRunContextText = (text: string): boolean =>
  text.startsWith("Context from the platform:") ||
  text.startsWith("Context update (replaces the earlier values):");

/** A user turn's blocks without the leading sender line (`From <name> (<role>)`). */
export function withoutSenderLine<B extends ContentBlock>(blocks: readonly B[]): B[] {
  const first = blocks[0];
  return blocks.length > 1 && first?.type === "text" && /^From [^\n]+$/.test(first.text)
    ? blocks.slice(1)
    : [...blocks];
}

/**
 * A captured request without its run context: the snapshot system messages dropped and each user
 * turn's sender line removed (for tests about other request contents).
 */
export function withoutRunContext<
  R extends { messages: readonly { role: string; content: unknown }[] },
>(req: R): R {
  return {
    ...req,
    messages: req.messages
      .filter(
        (m) =>
          !(m.role === "system" && typeof m.content === "string" && isRunContextText(m.content)),
      )
      .map((m) =>
        m.role === "user" && Array.isArray(m.content)
          ? { ...m, content: withoutSenderLine(m.content as ContentBlock[]) }
          : m,
      ),
  };
}
