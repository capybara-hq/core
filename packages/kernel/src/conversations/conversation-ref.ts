/**
 * Referenced conversations (@ conversations spec §1–§2): a message may name up to
 * {@link MAX_CONVERSATION_REFS} of the sender's own conversations; each becomes one English text
 * block built here from what was read at send time and logged in the `user_message`, so request
 * building and replay never read another conversation.
 */

/** The most conversations one message may reference. */
export const MAX_CONVERSATION_REFS = 3;
/** The newest user / assistant message events read after the latest summary (or from the start). */
export const REF_TURN_MESSAGES = 12;
/** The longest summary text kept (characters); longer keeps its head and tail. */
export const REF_SUMMARY_MAX = 12_000;
/** The longest message text kept (characters); longer keeps its head and tail. */
export const REF_MESSAGE_MAX = 1_500;
/** The longest block (characters); older messages are dropped first to fit. */
export const REF_BLOCK_MAX = 16_000;

/** What a referenced conversation's block is built from, read at send time. */
export interface ConversationRefSource {
  id: string;
  /** The title at send time; null: untitled. */
  title: string | null;
  /** The name of the conversation's agent. */
  agentName: string;
  /** When the conversation was last active (its `updated_at`). */
  lastActiveAt: Date;
  /** A run was in progress when it was read: what it had not logged yet is absent. */
  running: boolean;
  /** The latest `compaction_summary` text; null: none. */
  summary: string | null;
  /** The messages after the summary (or the latest ones without one), oldest first. */
  messages: readonly { role: "user" | "assistant"; text: string }[];
}

/** Characters of `text` (code points, so a clip never splits a surrogate pair). */
const chars = (text: string): string[] => Array.from(text);

/**
 * `text` clipped to at most `max` characters plus the omission marker: its head and its tail are
 * kept (the end of a summary holds its current work), the middle replaced by
 * `[… n characters omitted …]`.
 */
export function clipMiddle(text: string, max: number): string {
  const cs = chars(text);
  if (cs.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = cs.length - head - tail;
  return `${cs.slice(0, head).join("")}\n[… ${omitted} characters omitted …]\n${cs
    .slice(cs.length - tail)
    .join("")}`;
}

/**
 * The model-visible text of one referenced conversation: a header naming it (title, id, agent,
 * last active date, a running note), its summary clipped to {@link REF_SUMMARY_MAX}, its latest
 * messages each clipped to {@link REF_MESSAGE_MAX}, and a closing line pointing to the Platform
 * tool's `conversations.events` read. The whole block stays within {@link REF_BLOCK_MAX}
 * characters by dropping the oldest messages first.
 */
export function conversationRefText(src: ConversationRefSource): string {
  const title = src.title !== null && src.title.trim() !== "" ? src.title : "Untitled conversation";
  const header =
    `Referenced conversation: "${title}" (id ${src.id}; another conversation of this person, with ` +
    `the agent ${src.agentName}, last active ${src.lastActiveAt.toISOString().slice(0, 10)}). ` +
    "The text below is quoted from it as context for this message." +
    (src.running ? " It was still running when referenced." : "");
  const summary =
    src.summary === null
      ? []
      : [`Summary of the conversation: ${clipMiddle(src.summary, REF_SUMMARY_MAX)}`];
  const closing =
    "End of the referenced conversation. If the Platform tool is available, more of it can be " +
    `read with its conversations.events operation (conversationId ${src.id}).`;
  const lines = src.messages.map(
    (m) => `${m.role === "user" ? "User" : "Agent"}: ${clipMiddle(m.text, REF_MESSAGE_MAX)}`,
  );
  const build = (kept: readonly string[]): string =>
    [header, ...summary, ...(kept.length > 0 ? ["Latest messages:", ...kept] : []), closing].join(
      "\n",
    );
  let start = 0;
  let text = build(lines);
  while (chars(text).length > REF_BLOCK_MAX && start < lines.length) {
    start++;
    text = build(lines.slice(start));
  }
  return text;
}

/**
 * The text a referenced conversation's message contributes: a `user_message`'s first block when
 * it is text (the typed text, so a message that itself referenced files or conversations brings
 * no nested blocks), an `assistant_message`'s text blocks (no thinking, tool calls or results).
 */
export function refMessageText(type: string, payload: unknown): string {
  const content = (payload as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  const textOf = (b: unknown): string | undefined => {
    const block = b as { type?: unknown; text?: unknown } | null;
    return block !== null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
      ? block.text
      : undefined;
  };
  if (type === "user_message") return (textOf(content[0]) ?? "").trim();
  return content
    .map(textOf)
    .filter((t): t is string => t !== undefined)
    .join("\n")
    .trim();
}
