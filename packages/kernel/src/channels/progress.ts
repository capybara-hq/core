import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../conversations/events.js";
import { conversationUrl } from "./cards.js";
import type { ChannelLocale } from "./phrases.js";

/**
 * The state of one run's progress card (process blocks spec §6.2, §10.1): a pure fold of the run's
 * conversation events. Serializable on purpose: the delivery keeps it between jobs, never in
 * process memory. Nothing here touches the database or the clock.
 */
export interface ProgressState {
  runId: string;
  startedAt: string;
  endedAt?: string;
  state: "running" | "waiting" | "finished" | "stopped" | "failed";
  /** The latest narration: first line, at most {@link STATUS_MAX} characters. */
  status?: string;
  /** The pinned card's Markdown text. */
  pinned?: string;
  /** The last {@link RECENT_MAX} tool labels, oldest first. */
  recent: string[];
  /** Handoff links; `titles` holds both languages so the card picks the recipient's. */
  pending: { text: string; url: string; titles?: { zh: string; en: string } }[];
  thoughts: number;
  tools: number;
  errors: number;
  /** Reserved: the pinned card's head is not known to the kernel. */
  pinnedTitle?: string;
  pinnedBadge?: string;
  /** Bumps when a pinned card's text changes (a milestone). */
  pinnedVersion: number;
}

const STATUS_MAX = 120;
const RECENT_MAX = 3;

export function initProgress(runId: string, startedAt: string): ProgressState {
  return {
    runId,
    startedAt,
    state: "running",
    recent: [],
    pending: [],
    thoughts: 0,
    tools: 0,
    errors: 0,
    pinnedVersion: 0,
  };
}

/** The first line of a narration, cut to {@link STATUS_MAX} characters with an ellipsis. */
function statusLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  const chars = [...line];
  return chars.length > STATUS_MAX ? `${chars.slice(0, STATUS_MAX - 1).join("")}…` : line;
}

/**
 * Folds one event into the state. `label` is the tool title and key argument helper the approval
 * card uses; `base` is the web base (absent: no links, so no pending entries).
 *
 * Contract: only this run's events count. An event of another run (a previous run, a sub-agent's)
 * is ignored, and so is every event after the run ended. Any approval or question decision flips
 * `waiting` back to `running`, even when a parallel ask is still pending (accepted behavior).
 */
export function reduceProgress(
  s: ProgressState,
  e: ConversationEvent,
  label: (toolKey: string, input: unknown) => string,
  base: string | undefined,
): ProgressState {
  if (e.runId !== null && e.runId !== s.runId) return s;
  if (s.endedAt !== undefined) return s;
  switch (e.type) {
    case "assistant_message": {
      const content = e.payload.content;
      const calls = content.filter((b) => b.type === "tool_call");
      const thoughts = content.filter((b) => b.type === "thinking").length;
      let status = s.status;
      // narration (spec §1.1): the text of a message that also calls a tool; answer text is not
      if (calls.length > 0) {
        const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
        status = statusLine(text) ?? status;
      }
      const recent = [...s.recent, ...calls.map((c) => label(c.name, c.input))].slice(-RECENT_MAX);
      return {
        ...s,
        ...(status !== undefined && { status }),
        recent,
        thoughts: s.thoughts + thoughts,
      };
    }
    case "tool_result": {
      const p = e.payload;
      let next: ProgressState = {
        ...s,
        tools: s.tools + 1,
        errors: s.errors + (p.isError ? 1 : 0),
      };
      const v = p.view;
      if (v?.kind === "handoff" && base !== undefined) {
        const url =
          v.target.type === "link"
            ? `${base}${v.target.url}`
            : conversationUrl(base, e.conversationId);
        next = {
          ...next,
          pending: [...next.pending, { text: v.title.en, url, titles: v.title }],
        };
      }
      if (p.card?.placement === "pinned" && p.card.text !== undefined) {
        if (p.card.text !== s.pinned)
          next = { ...next, pinned: p.card.text, pinnedVersion: s.pinnedVersion + 1 };
      }
      return next;
    }
    case "approval_requested":
    case "question_asked":
      return { ...s, state: "waiting" };
    case "approval_decided":
    case "question_answered":
      return s.state === "waiting" ? { ...s, state: "running" } : s;
    case "run_finished":
      return { ...s, state: "finished", endedAt: e.createdAt.toISOString() };
    case "run_failed":
      return { ...s, state: "failed", endedAt: e.createdAt.toISOString() };
    case "run_aborted":
      return { ...s, state: "stopped", endedAt: e.createdAt.toISOString() };
    default:
      return s;
  }
}

const COPY = {
  zh: {
    running: "处理中",
    waiting: "等待你确认",
    stopped: "已停止",
    failed: "处理失败",
    elapsed: (t: string) => `已用 ${t}`,
    worked: (t: string) => `已处理 ${t}`,
    tools: (n: number) => `${n} 个工具`,
    errors: (n: number) => `${n} 个调用出错`,
    hours: (h: number, m: number) => `${h} 小时 ${m} 分`,
    minutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
    seconds: (s: number) => `${s} 秒`,
    link: "在网页查看完整过程",
  },
  en: {
    running: "Working",
    waiting: "Waiting for your approval",
    stopped: "Stopped",
    failed: "Failed",
    elapsed: (t: string) => `Elapsed ${t}`,
    worked: (t: string) => `Worked for ${t}`,
    tools: (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`,
    errors: (n: number) => `${n} ${n === 1 ? "call" : "calls"} failed`,
    hours: (h: number, m: number) => `${h}h ${m}m`,
    minutes: (m: number, s: number) => `${m}m ${s}s`,
    seconds: (s: number) => `${s}s`,
    link: "See the full process on the web",
  },
} as const;

/** `2 分 43 秒` / `2m 43s`; the running meta uses `m:ss` instead. */
function duration(ms: number, t: (typeof COPY)[ChannelLocale]): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total >= 3600) return t.hours(Math.floor(total / 3600), Math.floor((total % 3600) / 60));
  if (total >= 60) return t.minutes(Math.floor(total / 60), total % 60);
  return t.seconds(total);
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * The progress card for the state. A finished run is one summary line (title and meta) with its
 * pending links; `brief` drops the steps and the status line.
 */
export function progressCard(
  s: ProgressState,
  opts: {
    base: string;
    conversationId: string;
    locale: ChannelLocale;
    mode: "detailed" | "brief";
    now: number;
  },
): Extract<ChannelCard, { kind: "progress" }> {
  const t = COPY[opts.locale];
  const started = Date.parse(s.startedAt);
  const ended = s.endedAt === undefined ? opts.now : Date.parse(s.endedAt);
  const ongoing = s.state === "running" || s.state === "waiting";
  const counts = [
    ...(s.tools > 0 ? [t.tools(s.tools)] : []),
    ...(s.errors > 0 ? [t.errors(s.errors)] : []),
  ];
  const title = s.state === "finished" ? t.worked(duration(ended - started, t)) : t[s.state];
  const meta = ongoing
    ? t.elapsed(clock(ended - started))
    : counts.length > 0
      ? counts.join(" · ")
      : undefined;
  const live = ongoing && opts.mode === "detailed";
  return {
    kind: "progress",
    state: s.state,
    title,
    ...(meta !== undefined && { meta }),
    ...(live && s.status !== undefined && { status: s.status }),
    ...(ongoing && s.pinned !== undefined && { pinned: s.pinned }),
    steps: live ? [...s.recent] : [],
    pending: s.pending.map((p) => ({ text: p.titles?.[opts.locale] ?? p.text, url: p.url })),
    url: conversationUrl(opts.base, opts.conversationId),
    urlText: t.link,
  };
}
