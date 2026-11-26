import { renderCardAsText, validateChannelCard } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  initProgress,
  type ProgressState,
  progressCard,
  reduceProgress,
} from "../../src/channels/progress.js";
import type { ConversationEvent } from "../../src/conversations/events.js";

const T0 = "2026-11-26T10:00:00.000Z";
const label = (key: string, input: unknown) => {
  const arg = (input as { cmd?: string } | undefined)?.cmd;
  return arg === undefined ? key : `${key}: ${arg}`;
};

let seq = 0;
const ev = (type: string, payload: unknown, at = T0): ConversationEvent =>
  ({
    type,
    payload,
    conversationId: "c1",
    seq: ++seq,
    runId: "r1",
    createdAt: new Date(at),
  }) as unknown as ConversationEvent;

const reduce = (s: ProgressState, ...es: ConversationEvent[]) =>
  es.reduce((acc, e) => reduceProgress(acc, e, label, "https://cap.example"), s);
const start = () => initProgress("r1", T0);
const assistant = (content: unknown[]) =>
  ev("assistant_message", { step: 1, content, stopReason: "tool_use" });
const call = (id: string, cmd: string) => ({ type: "tool_call", id, name: "Bash", input: { cmd } });
const result = (extra: Record<string, unknown> = {}) =>
  ev("tool_result", {
    step: 1,
    callId: "k",
    toolKey: "Bash",
    content: "ok",
    isError: false,
    ...extra,
  });

const opts = (over: Record<string, unknown> = {}) =>
  ({
    base: "https://cap.example",
    conversationId: "c1",
    locale: "zh",
    mode: "detailed",
    now: Date.parse(T0) + 42_000,
    ...over,
  }) as Parameters<typeof progressCard>[1];

describe("reduceProgress", () => {
  it("narration becomes the status line", () => {
    const s = reduce(
      start(),
      assistant([{ type: "text", text: `${"a".repeat(130)}\nsecond` }, call("k", "ls")]),
    );
    expect(s.status).toBe(`${"a".repeat(119)}…`);
    expect(
      reduce(start(), assistant([{ type: "text", text: "Reading files\nmore" }, call("k", "ls")]))
        .status,
    ).toBe("Reading files");
  });

  it("answer text does not", () => {
    const s = reduce(start(), assistant([{ type: "text", text: "The answer" }]));
    expect(s.status).toBeUndefined();
  });

  it("recent keeps the last three tool labels", () => {
    const s = reduce(
      start(),
      assistant([call("1", "a"), call("2", "b"), call("3", "c"), call("4", "d")]),
    );
    expect(s.recent).toEqual(["Bash: b", "Bash: c", "Bash: d"]);
  });

  it("handoff adds a pending link", () => {
    const view = {
      kind: "handoff",
      title: { zh: "确认邀请", en: "Confirm invite" },
      target: { type: "link", url: "/admin/members" },
    };
    const s = reduce(start(), result({ view }));
    expect(progressCard(s, opts())).toMatchObject({
      pending: [{ text: "确认邀请", url: "https://cap.example/admin/members" }],
    });
    expect(progressCard(s, opts({ locale: "en" }))).toMatchObject({
      pending: [{ text: "Confirm invite" }],
    });
    const none = reduceProgress(start(), result({ view }), label, undefined);
    expect(none.pending).toEqual([]);
  });

  it("approval_requested sets waiting, approval_decided resumes", () => {
    const w = reduce(start(), ev("approval_requested", { approvalId: "a" }));
    expect(w.state).toBe("waiting");
    expect(progressCard(w, opts())).toMatchObject({ state: "waiting", title: "等待你确认" });
    expect(reduce(w, ev("approval_decided", { approvalId: "a", decision: "approved" })).state).toBe(
      "running",
    );
  });

  it("a sub-agent's approval or question waits, its finish resumes; a connect request does not wait", () => {
    const waiting = (kind: string) =>
      ev("subagent_waiting", {
        subagentId: "c2",
        childRunId: "r2",
        path: ["c2"],
        kind,
        toolKey: "Bash",
      });
    const finished = ev("subagent_finished", {
      subagentId: "c2",
      childRunId: "r2",
      callId: "k",
      status: "completed",
      toolCalls: 1,
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(reduce(start(), waiting("approval")).state).toBe("waiting");
    expect(reduce(start(), waiting("input")).state).toBe("waiting");
    expect(reduce(start(), waiting("approval"), finished).state).toBe("running");
    expect(reduce(start(), waiting("connect")).state).toBe("running");
  });

  it("run_finished finishes with the summary title and meta (zh and en)", () => {
    let s = start();
    for (let i = 0; i < 12; i++) s = reduce(s, result({ isError: i === 0 }));
    s = reduce(s, ev("run_finished", { reason: "completed" }, "2026-11-26T10:02:43.000Z"));
    expect(s.state).toBe("finished");
    expect(progressCard(s, opts())).toMatchObject({
      state: "finished",
      title: "已处理 2 分 43 秒",
      meta: "12 个工具 · 1 个调用出错",
      steps: [],
    });
    expect(progressCard(s, opts({ locale: "en" }))).toMatchObject({
      title: "Worked for 2m 43s",
      meta: "12 tools · 1 call failed",
    });
  });

  it("failed and aborted runs end as failed and stopped", () => {
    expect(reduce(start(), ev("run_failed", { error: { code: "x", message: "y" } })).state).toBe(
      "failed",
    );
    expect(reduce(start(), ev("run_aborted", { byAccountId: null, reason: "user" })).state).toBe(
      "stopped",
    );
  });

  it("pinned text bumps pinnedVersion only when it changes", () => {
    const pin = (text: string) =>
      result({ card: { plugin: "p", view: "todo", placement: "pinned", text } });
    let s = reduce(start(), pin("- [ ] a"));
    expect([s.pinned, s.pinnedVersion]).toEqual(["- [ ] a", 1]);
    s = reduce(s, pin("- [ ] a"));
    expect(s.pinnedVersion).toBe(1);
    s = reduce(s, pin("- [x] a"));
    expect([s.pinned, s.pinnedVersion]).toEqual(["- [x] a", 2]);
    expect(progressCard(s, opts())).toMatchObject({ pinned: "- [x] a" });
  });

  it("brief has no steps", () => {
    const s = reduce(start(), assistant([{ type: "text", text: "Working" }, call("1", "a")]));
    expect(progressCard(s, opts())).toMatchObject({ steps: ["Bash: a"], status: "Working" });
    const brief = progressCard(s, opts({ mode: "brief" }));
    expect(brief).toMatchObject({ steps: [] });
    expect(brief).not.toHaveProperty("status");
  });

  it("running card is valid and shows elapsed time", () => {
    const card = progressCard(start(), opts());
    expect(validateChannelCard(card)).toEqual([]);
    expect(card).toMatchObject({
      title: "处理中",
      meta: "已用 0:42",
      url: "https://cap.example/chat/c1",
    });
    expect(renderCardAsText(card, "zh")).toContain("https://cap.example/chat/c1");
  });

  it("events of another run leave the state unchanged", () => {
    const s = start();
    const foreign = (e: ConversationEvent) => ({ ...e, runId: "other" }) as ConversationEvent;
    expect(reduce(s, foreign(ev("run_finished", { reason: "completed" })))).toEqual(s);
    expect(reduce(s, foreign(result()))).toEqual(s);
  });

  it("an ended run ignores later events", () => {
    for (const end of [
      ev("run_finished", { reason: "completed" }),
      ev("run_failed", { error: { code: "x", message: "y" } }),
      ev("run_aborted", { byAccountId: null, reason: "user" }),
    ]) {
      const done = reduce(start(), end);
      const after = reduce(
        done,
        ev("approval_requested", { approvalId: "a" }),
        assistant([{ type: "text", text: "late" }, call("1", "a")]),
        result(),
      );
      expect(after).toEqual(done);
    }
  });

  it("hours, stopped and failed titles", () => {
    const end = (e: ConversationEvent) => reduce(start(), e);
    const fin = end(ev("run_finished", { reason: "completed" }, "2026-11-26T11:02:03.000Z"));
    expect(progressCard(fin, opts()).title).toBe("已处理 1 小时 2 分");
    expect(progressCard(fin, opts({ locale: "en" })).title).toBe("Worked for 1h 2m");
    expect(
      progressCard(end(ev("run_aborted", { byAccountId: null, reason: "user" })), opts()).title,
    ).toBe("已停止");
    expect(
      progressCard(
        end(ev("run_failed", { error: { code: "x", message: "y" } })),
        opts({ locale: "en" }),
      ).title,
    ).toBe("Failed");
  });
});
