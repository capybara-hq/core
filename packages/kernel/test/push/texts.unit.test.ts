import { validatePushMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  PUSH_TEXT_KEYS,
  pushText,
  type ResolvedPush,
  renderPushMessage,
} from "../../src/push/texts.js";

/** The exact push copy (plan global constraints, "Exact push copy") and how a message is built. */

const COPY = {
  approval: ["needs your approval", "需要你的审批"],
  question: ["has a question for you", "有问题需要你回答"],
  connect: ["needs you to connect an account", "需要你连接账号"],
  runFinished: ["finished", "已完成"],
  runFailed: ["failed", "运行失败"],
  backgroundFinished: ["a background task ended", "后台任务已结束"],
  subagentFinished: ["a sub-agent finished", "子智能体已完成"],
  automationRan: ["your automation ran", "你的自动化已运行"],
  automationFailed: ["your automation failed", "你的自动化运行失败"],
  inboxItem: ["a new item in your inbox", "收件箱有新事项"],
} as const;

const resolved = (over: Partial<ResolvedPush> = {}): ResolvedPush => ({
  eventId: "conv-c1-7",
  orgId: "o1",
  accountIds: ["a1"],
  category: "replies",
  path: "/chat/c1?org=o1",
  threadId: "c1",
  title: "Helper",
  conversationTitle: "Deploy check",
  text: "runFinished",
  ...over,
});

describe("push texts", () => {
  it("every key has the en and zh copy", () => {
    expect([...PUSH_TEXT_KEYS].sort()).toEqual(Object.keys(COPY).sort());
    for (const [key, [en, zh]] of Object.entries(COPY)) {
      expect(pushText(key as keyof typeof COPY, "en")).toBe(en);
      expect(pushText(key as keyof typeof COPY, "zh")).toBe(zh);
    }
  });

  it("zh says 智能体, never 企业 or the Latin word agent", () => {
    for (const key of PUSH_TEXT_KEYS) {
      const zh = pushText(key, "zh");
      expect(zh).not.toContain("企业");
      expect(zh).not.toMatch(/agent/i);
    }
  });
});

describe("renderPushMessage", () => {
  it("previews off: the agent name and the sentence, never the conversation title", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const text of PUSH_TEXT_KEYS) {
        const m = renderPushMessage(resolved({ text }), locale, "off", "https://cap.example");
        expect(JSON.stringify(m)).not.toContain("Deploy check");
        expect(m.body).toBe(pushText(text, locale));
      }
    }
    expect(renderPushMessage(resolved(), "en", "off", "https://cap.example")).toEqual({
      title: "Helper",
      body: "finished",
      path: "/chat/c1?org=o1",
      threadId: "c1",
      collapseId: "conv-c1-7",
      origin: "https://cap.example",
    });
  });

  it("previews titles: the conversation title leads the body", () => {
    expect(renderPushMessage(resolved(), "en", "titles", "https://cap.example").body).toBe(
      "Deploy check: finished",
    );
    expect(renderPushMessage(resolved(), "zh", "titles", "https://cap.example").body).toBe(
      "Deploy check：已完成",
    );
    expect(
      renderPushMessage(resolved({ conversationTitle: null }), "en", "titles", "https://x.example")
        .body,
    ).toBe("finished");
  });

  it("cuts the title and the body to the limits", () => {
    const m = renderPushMessage(
      resolved({ title: "n".repeat(300), conversationTitle: "t".repeat(500) }),
      "en",
      "titles",
      "https://cap.example",
    );
    expect(m.title).toBe("n".repeat(100));
    expect(m.body).toHaveLength(240);
    expect(validatePushMessage(m)).toBeNull();
  });

  it("does not split a surrogate pair at the cut", () => {
    const m = renderPushMessage(
      resolved({ title: `${"n".repeat(99)}😀` }),
      "en",
      "off",
      "https://cap.example",
    );
    expect(m.title).toBe("n".repeat(99));
  });
});
