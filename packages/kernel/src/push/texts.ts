import { PUSH_LIMITS, type PushMessage } from "@capybara-hq/plugin-sdk";
import type { PushCategory, PushTextKey } from "./triggers.js";

/** The push copy (mobile app spec §9.5): the body's fixed sentence per key and locale. */
const PUSH_TEXTS: Record<PushTextKey, { en: string; zh: string }> = {
  approval: { en: "needs your approval", zh: "需要你的审批" },
  question: { en: "has a question for you", zh: "有问题需要你回答" },
  connect: { en: "needs you to connect an account", zh: "需要你连接账号" },
  runFinished: { en: "finished", zh: "已完成" },
  runFailed: { en: "failed", zh: "运行失败" },
  backgroundFinished: { en: "a background task ended", zh: "后台任务已结束" },
  subagentFinished: { en: "a sub-agent finished", zh: "子智能体已完成" },
  automationRan: { en: "your automation ran", zh: "你的自动化已运行" },
  automationFailed: { en: "your automation failed", zh: "你的自动化运行失败" },
  inboxItem: { en: "a new item in your inbox", zh: "收件箱有新事项" },
};

/** Every push text key. */
export const PUSH_TEXT_KEYS = Object.keys(PUSH_TEXTS) as readonly PushTextKey[];

/** The sentence of `key` in `locale`. */
export function pushText(key: PushTextKey, locale: "zh" | "en"): string {
  return PUSH_TEXTS[key][locale];
}

/** An event's push as the fanout resolved it (`recipients.ts`), with the event id. */
export interface ResolvedPush {
  /**
   * `conv-<conversationId>-<seq>`, `automation-<taskRunId>` or `inbox-<itemId>`: the message's
   * collapse id.
   */
  eventId: string;
  orgId: string;
  accountIds: string[];
  category: PushCategory;
  /** In-app path with `?org=` (plan decision 8). */
  path: string;
  /** The root conversation id, `automation-<taskId>`, or `inbox` for an inbox item. */
  threadId: string;
  /**
   * The agent's display name (the task's name for an automation, the plugin's display name or
   * `Capybara` for an inbox item; a localized name is shown in the registration's locale).
   */
  title: string | { zh: string; en: string };
  /**
   * Shown only with `push.previews: "titles"` (an inbox item's title; a localized one is shown in
   * the registration's locale).
   */
  conversationTitle: string | { zh: string; en: string } | null;
  text: PushTextKey;
}

/** `s` cut to `max` UTF-16 units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/**
 * The message of `r` for one registration's locale. `title` is the agent's (or task's) name cut
 * to `PUSH_LIMITS.titleChars`; `body` is the fixed sentence, led by the conversation title only
 * with previews `titles` (`<title>: <sentence>`; zh joins them with a full-width colon), cut to
 * `PUSH_LIMITS.bodyChars`. Message and tool text are never part of it. `collapseId` is the event
 * id, so a resend of the same event replaces the notification on the device. No badge (decision 7).
 */
export function renderPushMessage(
  r: ResolvedPush,
  locale: "zh" | "en",
  previews: "off" | "titles",
  origin: string,
): PushMessage {
  const sentence = pushText(r.text, locale);
  const conversationTitle =
    r.conversationTitle === null || typeof r.conversationTitle === "string"
      ? r.conversationTitle
      : r.conversationTitle[locale];
  const lead = previews === "titles" && conversationTitle ? conversationTitle : null;
  const body = lead === null ? sentence : `${lead}${locale === "zh" ? "：" : ": "}${sentence}`;
  return {
    title: cut(typeof r.title === "string" ? r.title : r.title[locale], PUSH_LIMITS.titleChars),
    body: cut(body, PUSH_LIMITS.bodyChars),
    path: r.path,
    threadId: r.threadId,
    collapseId: r.eventId,
    origin,
  };
}
