import { describe, expect, it } from "vitest";
import {
  type ConversationRefSource,
  clipMiddle,
  conversationRefText,
  REF_BLOCK_MAX,
  REF_MESSAGE_MAX,
  REF_SUMMARY_MAX,
  refMessageText,
} from "../../src/conversations/conversation-ref.js";

/** The referenced conversation's block (@ conversations spec §2): format, clipping and bounds. */

const base: ConversationRefSource = {
  id: "c-1",
  title: "Pricing",
  agentName: "Helper",
  lastActiveAt: new Date("2026-11-20T08:30:00Z"),
  running: false,
  summary: null,
  messages: [
    { role: "user", text: "what about the EU plan?" },
    { role: "assistant", text: "Prices stay in EUR." },
  ],
};

describe("conversationRefText", () => {
  it("an excerpt: the header with id, agent and date, the messages oldest first, the closing line", () => {
    expect(conversationRefText(base)).toBe(
      [
        'Referenced conversation: "Pricing" (id c-1; another conversation of this person, with the agent Helper, last active 2026-11-20). The text below is quoted from it as context for this message.',
        "Latest messages:",
        "User: what about the EU plan?",
        "Agent: Prices stay in EUR.",
        "End of the referenced conversation. If the Platform tool is available, more of it can be read with its conversations.events operation (conversationId c-1).",
      ].join("\n"),
    );
  });

  it("a summary, the running note and an untitled conversation; no messages after the summary", () => {
    const text = conversationRefText({
      ...base,
      title: null,
      running: true,
      summary: "We settled on EUR.",
      messages: [],
    });
    expect(text.split("\n")).toEqual([
      'Referenced conversation: "Untitled conversation" (id c-1; another conversation of this person, with the agent Helper, last active 2026-11-20). The text below is quoted from it as context for this message. It was still running when referenced.',
      "Summary of the conversation: We settled on EUR.",
      "End of the referenced conversation. If the Platform tool is available, more of it can be read with its conversations.events operation (conversationId c-1).",
    ]);
  });

  it("clips a long summary to its head and tail, a long message likewise", () => {
    const summary = `HEAD${"s".repeat(REF_SUMMARY_MAX * 2)}TAIL`;
    const message = `START${"m".repeat(REF_MESSAGE_MAX * 3)}END`;
    const text = conversationRefText({
      ...base,
      summary,
      messages: [{ role: "user", text: message }],
    });
    expect(text).toContain("Summary of the conversation: HEAD");
    expect(text).toContain("TAIL\nLatest messages:");
    expect(text).toContain(`[… ${summary.length - REF_SUMMARY_MAX} characters omitted …]`);
    expect(text).toContain("User: START");
    expect(text).toContain(`END\nEnd of the referenced conversation.`);
    expect(text).toContain(`[… ${message.length - REF_MESSAGE_MAX} characters omitted …]`);
  });

  it("stays within the block bound by dropping the oldest messages first", () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `#${i} ${"x".repeat(REF_MESSAGE_MAX)}`,
    }));
    const text = conversationRefText({
      ...base,
      summary: "y".repeat(REF_SUMMARY_MAX * 2),
      messages,
    });
    expect(Array.from(text).length).toBeLessThanOrEqual(REF_BLOCK_MAX);
    expect(text).toContain("#11 ");
    expect(text).not.toContain("#0 ");
    expect(text).toContain("End of the referenced conversation.");
    // without a summary more messages fit, still within the bound and newest kept
    const excerpt = conversationRefText({ ...base, messages });
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(REF_BLOCK_MAX);
    expect(excerpt).toContain("#11 ");
  });
});

describe("clipMiddle", () => {
  it("keeps text within the bound as it is and never splits a surrogate pair", () => {
    expect(clipMiddle("short", 10)).toBe("short");
    const clipped = clipMiddle("😀".repeat(10), 4);
    expect(clipped).toBe("😀😀\n[… 6 characters omitted …]\n😀😀");
  });
});

describe("refMessageText", () => {
  it("a user message gives its first text block only; an assistant message its text blocks", () => {
    expect(
      refMessageText("user_message", {
        content: [
          { type: "text", text: " typed " },
          { type: "text", text: "Referenced conversation: nested" },
        ],
      }),
    ).toBe("typed");
    expect(refMessageText("user_message", { content: [{ type: "document", source: {} }] })).toBe(
      "",
    );
    expect(
      refMessageText("assistant_message", {
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "one" },
          { type: "tool_use", id: "t", name: "Read", input: {} },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });
});
