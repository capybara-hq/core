import { summarizeTools } from "@capybara-hq/design";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import {
  awaitingRun,
  buildEventTimeline,
  buildTimeline,
  latestUsage,
  runStats,
  type TimelineEntry,
  withDrafts,
  workingLineVisible,
} from "../src/lib/timeline";

let t = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
}
const user = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
  ev(
    seq,
    "user_message",
    { content: [{ type: "text", text }], authorAccountId: "a1", ...extra },
    null,
  );
const calls = (seq: number, list: { id: string; name: string; input: unknown }[], text = "") =>
  ev(seq, "assistant_message", {
    step: 0,
    stopReason: "tool_use",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...list.map((c) => ({ type: "tool_call", ...c })),
    ],
  });
const started = (seq: number, callId: string, toolKey: string) =>
  ev(seq, "tool_call_started", { step: 0, callId, toolKey, specHash: "h" });
const result = (
  seq: number,
  callId: string,
  toolKey: string,
  extra: Record<string, unknown> = {},
) => ev(seq, "tool_result", { step: 0, callId, toolKey, content: "ok", isError: false, ...extra });

const INFO = new Map<string, ToolInfo>([
  [
    "Bash",
    {
      key: "Bash",
      title: null,
      kind: "command",
      sandbox: true,
      keyArgs: ["command"],
      tool: null,
      source: { kind: "builtin" },
    },
  ],
  [
    "plugin__slack__search",
    {
      key: "plugin__slack__search",
      title: "Search messages",
      kind: "connector",
      sandbox: false,
      keyArgs: ["query"],
      tool: "search",
      source: { kind: "connector", id: "k1", name: "Slack" },
    },
  ],
]);

const kinds = (entries: TimelineEntry[]) => entries.map((e) => e.kind);
const tools = (entries: TimelineEntry[]) =>
  entries.filter((e): e is Extract<TimelineEntry, { kind: "tools" }> => e.kind === "tools");

describe("buildTimeline", () => {
  it("a log written before UI refresh B renders rows from the key and the first string input", () => {
    const events = [
      user(1, "list files"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      calls(3, [{ id: "c1", name: "Bash", input: { command: "ls -la" } }]),
      started(4, "c1", "Bash"),
      ev(5, "tool_result", {
        step: 0,
        callId: "c1",
        toolKey: "Bash",
        content: "a\nb",
        isError: false,
      }),
      ev(6, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }),
    ];
    const out = buildTimeline(events, [], new Map(), "zh");
    expect(kinds(out)).toEqual(["user", "tools", "run"]);
    const row = tools(out)[0]?.rows[0]?.row;
    expect(row).toMatchObject({
      name: "Bash",
      keyArg: "ls -la",
      status: "done",
      kind: "tool",
    });
    expect(row?.durationMs).toBe(1000);
    expect(row?.detail?.output).toBe("a\nb");
  });

  it("[bash, bash(exit 1), slack] is one group: 已运行 2 个命令，已使用 1 个工具（1 个失败）", () => {
    const events = [
      user(1, "go"),
      calls(2, [
        { id: "a", name: "Bash", input: { command: "ls", description: "List files" } },
        { id: "b", name: "Bash", input: { command: "false", description: "Fail" } },
        { id: "c", name: "plugin__slack__search", input: { query: "#feedback" } },
      ]),
      result(3, "a", "Bash", {
        view: { kind: "command", exitCode: 0, timedOut: false, description: "List files" },
      }),
      result(4, "b", "Bash", {
        content: "boom\nmore",
        view: { kind: "command", exitCode: 1, timedOut: false },
      }),
      result(5, "c", "plugin__slack__search"),
    ];
    const out = buildTimeline(events, [], INFO, "zh");
    expect(kinds(out)).toEqual(["user", "tools"]);
    const rows = tools(out)[0]?.rows.map((r) => r.row) ?? [];
    expect(summarizeTools(rows, "zh")).toBe("已运行 2 个命令，已使用 1 个工具（1 个失败）");
    expect(rows[0]).toMatchObject({ description: "List files", detail: { command: "ls" } });
    expect(rows[1]).toMatchObject({ status: "failed", error: "boom" });
    expect(rows[0]).toMatchObject({ name: "Bash" });
    expect(rows[0]).not.toHaveProperty("tool");
    expect(rows[2]).toMatchObject({
      name: "Slack",
      tool: "search",
      tooltip: "Search messages",
      keyArg: "#feedback",
    });
  });

  it("a Write that could not be diffed (truncated, no hunks) has no +0 −0 and no diff", () => {
    const events = [
      user(1, "go"),
      calls(2, [{ id: "w", name: "Write", input: { file_path: "/w/big.bin", content: "x" } }]),
      result(3, "w", "Write", {
        view: {
          kind: "edit",
          path: "/w/big.bin",
          created: false,
          added: 0,
          removed: 0,
          hunks: [],
          truncated: true,
        },
      }),
    ];
    const row = tools(buildTimeline(events, [], new Map(), "en"))[0]?.rows[0]?.row;
    expect(row).toMatchObject({ name: "Write", keyArg: "/w/big.bin" });
    expect(row?.added).toBeUndefined();
    expect(row?.removed).toBeUndefined();
    expect(row?.detail?.diff).toBeUndefined();
  });

  it("prose between calls and an approval split groups; prose is never folded", () => {
    const events = [
      user(1, "go"),
      calls(2, [{ id: "a", name: "Bash", input: { command: "ls" } }]),
      result(3, "a", "Bash"),
      calls(4, [{ id: "b", name: "Bash", input: { command: "pwd" } }], "Now the folder."),
      ev(5, "approval_requested", {
        step: 0,
        callId: "b",
        approvalId: "ap1",
        toolKey: "Bash",
        expiresAt: "x",
        policy: "agent",
      }),
      calls(6, [{ id: "c", name: "Bash", input: { command: "id" } }]),
    ];
    const out = buildTimeline(events, [], INFO, "en");
    expect(kinds(out)).toEqual(["user", "tools", "prose", "tools", "approval", "tools"]);
    const ap = out[4];
    expect(ap?.kind === "approval" && ap.item).toMatchObject({
      toolKey: "Bash",
      input: { command: "pwd" },
      policy: "agent",
    });
  });

  it("artifact_created lands after the group of its call; a card follows the files", () => {
    const events = [
      user(1, "go"),
      calls(2, [
        { id: "a", name: "Deliver", input: { path: "out.csv" } },
        { id: "b", name: "plugin__todo__write", input: { items: [] } },
      ]),
      result(3, "a", "Deliver"),
      ev(4, "artifact_created", {
        artifactId: "f1",
        name: "out.csv",
        contentType: "text/csv",
        size: 9,
        sourcePath: "/w/out.csv",
        callId: "a",
      }),
      result(5, "b", "plugin__todo__write", { card: { plugin: "todo", view: "tasks-card" } }),
      calls(6, [], "Done."),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "tools", "files", "card", "prose"]);
    const files = out[2];
    expect(files?.kind === "files" && files.files[0]).toMatchObject({ id: "f1", name: "out.csv" });
    expect(out[3]).toMatchObject({ plugin: "todo", view: "tasks-card", callId: "b" });
  });

  it("an extension's display summary reads as the row's extra, in the locale", () => {
    const events = [
      calls(1, [{ id: "a", name: "plugin__todo__write", input: { todos: [] } }]),
      result(2, "a", "plugin__todo__write", {
        display: { summary: { zh: "更新任务清单（2 项）", en: "Updated task list (2 items)" } },
      }),
    ];
    expect(tools(buildTimeline(events, [], new Map(), "zh"))[0]?.rows[0]?.row.extra).toBe(
      "更新任务清单（2 项）",
    );
    expect(tools(buildTimeline(events, [], new Map(), "en"))[0]?.rows[0]?.row.extra).toBe(
      "Updated task list (2 items)",
    );
  });

  it("hook_denied with a callId marks the row as blocked by the extension", () => {
    const events = [
      calls(1, [{ id: "a", name: "plugin__slack__search", input: { query: "x" } }]),
      ev(2, "hook_denied", {
        mount: "tool.preExecute",
        plugin: "compliance",
        reason: "no",
        cause: "deny",
        step: 0,
        callId: "a",
      }),
      result(3, "a", "plugin__slack__search", { isError: true, content: "denied" }),
    ];
    const row = tools(buildTimeline(events, [], INFO, "en"))[0]?.rows[0]?.row;
    expect(row).toMatchObject({ status: "failed", blockedBy: "compliance" });
  });

  it("run_aborted → a stopped run with who; a model.request denial names the extension", () => {
    const events = [
      ev(1, "run_aborted", { byAccountId: "a1", reason: "user" }),
      ev(
        2,
        "hook_denied",
        { mount: "model.request", plugin: "guard", reason: "pii", cause: "deny", step: 0 },
        "r2",
      ),
      ev(3, "run_failed", { error: { code: "run.hook_denied", message: "x" } }, "r2"),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(out[0]).toMatchObject({ kind: "run", status: "stopped", byAccountId: "a1" });
    expect(out[1]).toMatchObject({
      kind: "run",
      status: "failed",
      code: "run.hook_denied",
      hook: { plugin: "guard", reason: "pii" },
    });
  });

  it("compaction → a divider with the saved tokens of its usage", () => {
    const events = [
      ev(1, "usage", {
        step: 0,
        provider: "p",
        model: "m",
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        purpose: "compaction",
      }),
      ev(2, "compaction_summary", { coversUpToSeq: 1, text: "summary" }),
    ];
    expect(buildTimeline(events, [], new Map(), "en")).toEqual([
      { kind: "divider", key: "e2", divider: "compacted", summary: "summary", savedTokens: 900 },
    ]);
  });

  it("a retry folds into the failed run instead of a second bubble", () => {
    const events = [
      user(1, "hello"),
      ev(2, "run_failed", { error: { code: "model.timeout", message: "x" } }),
      user(3, "hello", { retryOf: 1 }),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "run"]);
    expect(out[1]).toMatchObject({
      status: "failed",
      retried: true,
      retry: { seq: 1, text: "hello" },
    });
  });

  it("phase D: Retry of a failed skill invocation repeats the skill with its arguments, not the rendered text", () => {
    const skill = {
      id: "s1",
      version: 2,
      source: "x",
      name: "brainstorming",
      plugin: "superpowers",
      arguments: "a b",
      mode: "inline",
    };
    const events = [
      user(1, "The user invoked the skill …", { skill }),
      ev(2, "run_failed", { error: { code: "model.timeout", message: "x" } }),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(out[0]).toMatchObject({
      kind: "user",
      text: "a b",
      skill: { label: "/brainstorming", mode: "inline" },
      instructions: "The user invoked the skill …",
    });
    expect(out[1]).toMatchObject({
      status: "failed",
      retry: { seq: 1, text: "a b", skill: "superpowers:brainstorming" },
    });
  });

  it("phase D: a fork's report entry; a plain message the model already took in does not wait", () => {
    const fork = {
      id: "s1",
      version: 1,
      source: "x",
      name: "review",
      arguments: "",
      mode: "fork",
      agentType: "general-purpose",
    };
    const events = [
      user(1, "first"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      ev(3, "model_call", {
        step: 1,
        provider: "p",
        model: "m",
        request: { absorbedUpToSeq: 1 },
      }),
      user(4, "lead", { skill: fork }),
      ev(
        5,
        "subagent_dispatched",
        {
          step: 0,
          callId: "skill-4",
          subagentId: "ch",
          childRunId: "cr",
          agentType: "general-purpose",
          description: "review",
          resumed: false,
          model: { provider: "p", model: "m" },
          invokedSeq: 4,
        },
        "r2",
      ),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "user", "subagents"]);
    expect(out[0]).not.toHaveProperty("waitsFor");
    // final review M1: a fork's content[0] is the lead, not the instructions (the child's task
    // holds them): no "Skill instructions" disclosure
    expect(out[1]).toMatchObject({ kind: "user", skill: { label: "/review", mode: "fork" } });
    expect(out[1]).not.toHaveProperty("instructions");
    const done = buildTimeline(
      [...events, ev(6, "skill_fork_result", { invokedSeq: 4, text: "REPORT" }, "r2")],
      [],
      new Map(),
      "en",
    );
    expect(done.at(-1)).toEqual({ kind: "skill-report", key: "e6", text: "REPORT" });
  });

  it("a fallback to the agent's model is a divider naming both models", () => {
    const events = [
      ev(
        1,
        "model_switched",
        { model: { provider: "p", model: "big" }, effort: null, byAccountId: "a1", reason: "user" },
        null,
      ),
      user(2, "hi"),
      ev(
        3,
        "model_switched",
        { model: null, effort: null, byAccountId: null, reason: "unavailable" },
        "r2",
      ),
      ev(4, "run_started", { agentVersion: 1, model: { provider: "p", model: "small" } }, "r2"),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(out[1]).toMatchObject({
      divider: "fallback",
      from: { model: "big" },
      to: { model: "small" },
    });
  });

  it("drafts stream at the end: live thinking, then prose", () => {
    const out = buildTimeline(
      [],
      [{ runId: "r1", step: 0, text: "", thinking: "hmm" }],
      new Map(),
      "en",
    );
    expect(out).toMatchObject([{ kind: "thinking", live: true, text: "hmm" }]);
    const out2 = buildTimeline(
      [],
      [{ runId: "r1", step: 0, text: "hel", thinking: "" }],
      new Map(),
      "en",
    );
    expect(out2).toMatchObject([{ kind: "prose", streaming: true, text: "hel" }]);
  });

  it("calls of a run that ended without a result are cancelled", () => {
    const events = [
      calls(1, [{ id: "a", name: "Bash", input: { command: "sleep 9" } }]),
      started(2, "a", "Bash"),
      ev(3, "run_aborted", { byAccountId: null, reason: "x" }),
    ];
    expect(tools(buildTimeline(events, [], INFO, "en"))[0]?.rows[0]?.row.status).toBe("cancelled");
  });
});

describe("run rows (spec §6.16.23)", () => {
  const usage = (seq: number, runId: string, input: number, output: number, extra = {}) =>
    ev(
      seq,
      "usage",
      {
        step: 0,
        provider: "p",
        model: "m2",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        ...extra,
      },
      runId,
    );

  it("a finished run ends with an ok row: the last call's model, the duration and the tokens", () => {
    const events = [
      user(1, "hi"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, "r1"),
      ev(3, "model_call", { step: 0, provider: "p", model: "m2" }, "r1"),
      usage(4, "r1", 100, 20),
      ev(5, "model_call", { step: 1, provider: "p", model: "m2" }, "r1"),
      usage(6, "r1", 200, 30),
      ev(
        7,
        "assistant_message",
        { step: 1, stopReason: "end_turn", content: [{ type: "text", text: "ok" }] },
        "r1",
      ),
      ev(8, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }, "r1"),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "prose", "run"]);
    expect(out[2]).toMatchObject({
      kind: "run",
      key: "e8",
      runId: "r1",
      status: "ok",
      model: { provider: "p", model: "m2" },
      durationMs: 6000,
      tokens: { input: 300, output: 50, cacheRead: 20, cacheWrite: 0, total: 370 },
    });
  });

  it("a run still going has no row", () => {
    const events = [
      user(1, "hi"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, "r1"),
      ev(3, "model_call", { step: 0, provider: "p", model: "m" }, "r1"),
    ];
    expect(kinds(buildTimeline(events, [], new Map(), "en"))).toEqual(["user"]);
  });

  it("a failed run keeps the code and the kernel's raw message; no usage, no tokens", () => {
    const events = [
      user(1, "hi"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, "r1"),
      ev(3, "run_failed", { error: { code: "model.auth", message: "401 Unauthorized" } }, "r1"),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "run"]);
    expect(out[1]).toMatchObject({
      kind: "run",
      status: "failed",
      code: "model.auth",
      message: "401 Unauthorized",
      hook: null,
      model: { provider: "p", model: "m" },
      durationMs: 1000,
      tokens: null,
      retry: { seq: 1, text: "hi" },
      retried: false,
    });
  });

  it("a stopped run names who stopped it; a run without run_started has no model or duration", () => {
    const events = [ev(1, "run_aborted", { byAccountId: "a1", reason: "user" }, "r9")];
    expect(buildTimeline(events, [], new Map(), "en")).toEqual([
      {
        kind: "run",
        key: "e1",
        runId: "r9",
        status: "stopped",
        byAccountId: "a1",
        at: expect.any(String),
        model: null,
        durationMs: null,
        tokens: null,
      },
    ]);
  });
});

describe("runStats", () => {
  it("counts runs and keeps the last run's span", () => {
    const events = [
      ev(1, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, "r1"),
      ev(2, "run_finished", { reason: "end_turn", consumedUpToSeq: 0 }, "r1"),
      ev(3, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, "r2"),
    ];
    const s = runStats(events);
    expect(s.turns).toBe(2);
    expect(s.endedAt).toBeNull();
    expect(s.startedAt).toBe(Date.parse((events[2] as ConversationEvent).createdAt));
  });
});

describe("final review fixes", () => {
  it("a read's line range is data for the thread's i18n, not a hard-coded string (m10)", () => {
    const events = [
      user(1, "read"),
      calls(2, [{ id: "r", name: "Read", input: { path: "a.ts" } }]),
      result(3, "r", "Read", {
        view: { kind: "read", path: "a.ts", fromLine: 3, toLine: 9 },
        display: { summary: { zh: "摘要", en: "summary" } },
      }),
    ];
    const tool = tools(buildTimeline(events, [], new Map(), "zh"))[0]?.rows[0];
    expect(tool?.lines).toEqual({ from: 3, to: 9 });
    expect(tool?.row.extra).toBeUndefined();
  });

  it("drafts are added after the log's entries, which keep their identity (I3)", () => {
    const events = [
      user(1, "hi"),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
    ];
    const base = buildEventTimeline(events, new Map(), "en");
    expect(withDrafts(base, [])).toBe(base.entries);
    const out = withDrafts(base, [{ runId: "r1", step: 0, text: "hel", thinking: "" }]);
    expect(out.slice(0, base.entries.length)).toEqual(base.entries);
    expect(out[0]).toBe(base.entries[0]);
    expect(out.at(-1)).toMatchObject({ kind: "prose", text: "hel", streaming: true });
    expect(out).toEqual(
      buildTimeline(events, [{ runId: "r1", step: 0, text: "hel", thinking: "" }], new Map(), "en"),
    );
  });
});

describe("web tools (WebSearch / WebFetch)", () => {
  const web = new Map<string, ToolInfo>([
    [
      "WebSearch",
      {
        key: "WebSearch",
        title: null,
        kind: "search",
        sandbox: false,
        keyArgs: ["query"],
        tool: null,
        source: { kind: "builtin" },
      },
    ],
    [
      "WebFetch",
      {
        key: "WebFetch",
        title: null,
        kind: "read",
        sandbox: false,
        keyArgs: ["url", "prompt"],
        tool: null,
        source: { kind: "builtin" },
      },
    ],
  ]);

  it("rows carry the kernel's kinds and key arguments (the query; the URL before the prompt)", () => {
    const events = [
      user(1, "look it up"),
      calls(2, [
        { id: "s", name: "WebSearch", input: { query: "capybara habitat", allowed_domains: [] } },
        {
          id: "f",
          name: "WebFetch",
          input: { prompt: "Summarize", url: "https://example.com/capybara" },
        },
      ]),
      result(3, "s", "WebSearch"),
      result(4, "f", "WebFetch"),
    ];
    const rows = tools(buildTimeline(events, [], web, "en"))[0]?.rows.map((r) => r.row) ?? [];
    expect(rows[0]).toMatchObject({
      name: "WebSearch",
      kind: "search",
      keyArg: "capybara habitat",
    });
    expect(rows[1]).toMatchObject({
      name: "WebFetch",
      kind: "read",
      keyArg: "https://example.com/capybara",
    });
    // search rows count with tools (design §7); a single read names its URL
    expect(summarizeTools(rows, "en")).toBe("Used 1 tool, read https://example.com/capybara");
  });

  it("a WebFetch extraction's usage (purpose web_fetch) is not the conversation's context", () => {
    const usage = (seq: number, inputTokens: number, extra: Record<string, unknown> = {}) =>
      ev(seq, "usage", {
        step: 0,
        provider: "p",
        model: "m",
        inputTokens,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...extra,
      });
    const events = [usage(1, 500), usage(2, 90_000, { purpose: "web_fetch", callId: "f" })];
    expect(latestUsage(events)?.inputTokens).toBe(500);
  });
});

describe("workingLineVisible (conversation send spec §2.2)", () => {
  const runStart = (seq: number, runId = "r1") =>
    ev(seq, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, runId);
  const finished = (seq: number, consumedUpToSeq: number, runId = "r1") =>
    ev(seq, "run_finished", { reason: "end_turn", consumedUpToSeq }, runId);
  const mine = (seq: number, text: string, cmid: string, extra: Record<string, unknown> = {}) =>
    user(seq, text, { clientMessageId: cmid, ...extra });
  type Draft = { runId: string; step: number; text: string; thinking: string };
  const at = (
    events: ConversationEvent[],
    s: { waiting?: boolean; pending?: number; sent?: string[] } = {},
    drafts: Draft[] = [],
  ) =>
    workingLineVisible(events, drafts, {
      waiting: s.waiting ?? false,
      pending: s.pending ?? 0,
      // sent here just now (the 60 s backstop has its own tests)
      sentHere: new Map((s.sent ?? []).map((id) => [id, 0])),
      paused: false,
      now: 1000,
    });

  it("shows for a pending send, before the log has anything of it", () => {
    expect(at([], { pending: 1 })).toBe(true);
    expect(at([user(1, "hi"), runStart(2), finished(3, 1)], { pending: 1 })).toBe(true);
  });

  it("shows for a message this tab sent until its run starts, then until the first output", () => {
    expect(at([mine(1, "hi", "m1")], { sent: ["m1"] })).toBe(true);
    expect(at([mine(1, "hi", "m1"), runStart(2)], { sent: ["m1"] })).toBe(true);
    // a run in progress shows it whoever sent the message
    expect(at([user(1, "hi"), runStart(2)])).toBe(true);
  });

  it("an idle old conversation ending in a user message shows no line", () => {
    expect(at([user(1, "hi")])).toBe(false);
    expect(at([mine(1, "hi", "m1")], { sent: [] })).toBe(false);
  });

  it("a message whose delivery failed (dropped from this tab's sends) shows no line", () => {
    // the kernel wrote it, the POST failed: the view forgets it was sent here
    expect(at([mine(1, "hi", "m1")], { sent: [] })).toBe(false);
  });

  it("a child conversation that is not running shows no line", () => {
    expect(
      at([
        ev(
          1,
          "user_message",
          {
            content: [{ type: "text", text: "task" }],
            authorAccountId: "a1",
            dispatch: { parentConversationId: "p", parentRunId: "r0", callId: "c" },
          },
          null,
        ),
      ]),
    ).toBe(false);
  });

  it("is gone at the first output: thinking, prose, a running tool", () => {
    const base = [user(1, "hi"), runStart(2)];
    expect(at(base, {}, [{ runId: "r1", step: 0, text: "", thinking: "hmm" }])).toBe(false);
    expect(at(base, {}, [{ runId: "r1", step: 0, text: "He", thinking: "" }])).toBe(false);
    const tool = [
      ...base,
      calls(3, [{ id: "c1", name: "Bash", input: { command: "ls" } }]),
      started(4, "c1", "Bash"),
    ];
    expect(at(tool)).toBe(false);
  });

  it("shows again after a tool result while the model has not answered", () => {
    const events = [
      user(1, "hi"),
      runStart(2),
      calls(3, [{ id: "c1", name: "Bash", input: { command: "ls" } }]),
      started(4, "c1", "Bash"),
      result(5, "c1", "Bash"),
    ];
    expect(at(events)).toBe(true);
    expect(at(events, {}, [{ runId: "r1", step: 1, text: "Done", thinking: "" }])).toBe(false);
  });

  it("a retried run shows the line until its first output", () => {
    const failed = [
      mine(1, "hi", "m1"),
      runStart(2),
      ev(3, "run_failed", { error: { code: "x", message: "m" } }),
    ];
    expect(at(failed, { sent: ["m1"] })).toBe(false);
    const retry = [...failed, mine(4, "hi", "m2", { retryOf: 1 })];
    expect(at(retry, { sent: ["m1", "m2"] })).toBe(true);
    const running = [...retry, runStart(5, "r2")];
    expect(at(running, { sent: ["m1", "m2"] })).toBe(true);
    expect(
      at(running, { sent: ["m1", "m2"] }, [{ runId: "r2", step: 0, text: "Hi", thinking: "" }]),
    ).toBe(false);
  });

  it("an interjection after the last model call shows the line for the next run", () => {
    const events = [
      user(1, "hi"),
      runStart(2),
      ev(3, "assistant_message", {
        step: 0,
        content: [{ type: "text", text: "Hello" }],
        stopReason: "end_turn",
      }),
      mine(4, "more", "m2"),
      finished(5, 1),
    ];
    expect(at(events, { sent: ["m2"] })).toBe(true);
    expect(at([...events, runStart(6, "r2")], { sent: ["m2"] })).toBe(true);
    // a run that consumed it answered it
    expect(at([...events.slice(0, 4), finished(5, 4)], { sent: ["m2"] })).toBe(false);
  });

  it("is gone at the run's end, also without output, and while waiting for a person", () => {
    const ended = [
      mine(1, "hi", "m1"),
      runStart(2),
      ev(3, "run_failed", { error: { code: "x", message: "m" } }),
    ];
    expect(at(ended, { sent: ["m1"] })).toBe(false);
    expect(at([user(1, "hi"), runStart(2)], { waiting: true })).toBe(false);
    expect(at([])).toBe(false);
  });
});

describe("awaitingRun gives up (review round 2, item 3)", () => {
  // the server's time is ten minutes behind: only this tab's own send time counts
  const mine = (seq: number) => ({
    ...user(seq, "hi", { clientMessageId: "m1" }),
    createdAt: "2026-11-04T09:50:00.000Z",
  });
  const sentAt = 1_000_000;
  const sent = new Map([["m1", sentAt]]);

  it("waits for the run of a message this tab sent, within 60 s of its send here", () => {
    expect(awaitingRun([mine(1)], sent, { paused: false, now: sentAt + 59_000 })).toBe(true);
  });

  it("a server createdAt 10 minutes in the past does not end the wait of a fresh local send", () => {
    const fresh = new Map([["m1", Date.now()]]);
    const events = [{ ...mine(1), createdAt: new Date(Date.now() - 600_000).toISOString() }];
    expect(awaitingRun(events, fresh, { paused: false, now: Date.now() })).toBe(true);
  });

  it("a run that never starts stops waiting 60 s after the send here (the backstop)", () => {
    expect(awaitingRun([mine(1)], sent, { paused: false, now: sentAt + 60_001 })).toBe(false);
    expect(
      workingLineVisible([mine(1)], [], {
        waiting: false,
        pending: 0,
        sentHere: sent,
        paused: false,
        now: sentAt + 60_001,
      }),
    ).toBe(false);
  });

  it("a paused queue means no run is coming", () => {
    expect(awaitingRun([mine(1)], sent, { paused: true, now: sentAt })).toBe(false);
  });
});

describe("calls that wait for a person (design §6.16.9)", () => {
  const ASK = {
    key: "AskUserQuestion",
    title: "Ask the user",
    kind: "meta",
    sandbox: false,
    keyArgs: [],
    tool: null,
    source: { kind: "builtin" },
  } as const satisfies ToolInfo;
  const info = new Map<string, ToolInfo>([...INFO, ["AskUserQuestion", ASK]]);
  const ask = (seq: number, questions: unknown[]) =>
    calls(seq, [{ id: "q", name: "AskUserQuestion", input: { questions } }]);
  const asked = (seq: number) =>
    ev(seq, "question_asked", {
      step: 0,
      callId: "q",
      questionId: "qs1",
      form: { fields: [] },
      expiresAt: "x",
    });
  const row = (events: ConversationEvent[], map = info) =>
    tools(buildTimeline(events, [], map, "zh"))[0]?.rows[0]?.row;
  const QUESTIONS = [{ header: "数据库", question: "用哪个数据库？", multiSelect: false }];

  it("a pending question marks its call waiting; the answer ends the wait", () => {
    const pending = [ask(1, QUESTIONS), started(2, "q", "AskUserQuestion"), asked(3)];
    expect(row(pending)).toMatchObject({ status: "running", waiting: "input" });
    const answered = [
      ...pending,
      ev(4, "question_answered", {
        questionId: "qs1",
        callId: "q",
        answer: null,
        byAccountId: "a1",
        outcome: "answered",
      }),
    ];
    const r = row(answered);
    expect(r?.status).toBe("running");
    expect(r?.waiting).toBeUndefined();
    expect(row([...answered, result(5, "q", "AskUserQuestion")])?.status).toBe("done");
  });

  it("a pending approval marks its call waiting until the decision", () => {
    const pending = [
      calls(1, [{ id: "b", name: "Bash", input: { command: "rm x" } }]),
      ev(2, "approval_requested", {
        step: 0,
        callId: "b",
        approvalId: "ap1",
        toolKey: "Bash",
        expiresAt: "x",
      }),
    ];
    expect(row(pending)).toMatchObject({ status: "pending", waiting: "approval" });
    const decided = [
      ...pending,
      ev(3, "approval_decided", {
        approvalId: "ap1",
        callId: "b",
        decision: "approved",
        byAccountId: "a1",
      }),
    ];
    expect(row(decided)?.waiting).toBeUndefined();
  });

  it("a connection wait lasts until the call's result", () => {
    const events = [
      calls(1, [{ id: "s", name: "plugin__slack__search", input: { query: "x" } }]),
      started(2, "s", "plugin__slack__search"),
      ev(3, "connection_required", { step: 0, callId: "s", appId: "k1", appName: "Slack" }),
    ];
    expect(row(events)?.waiting).toBe("connect");
    const done = row([...events, result(4, "s", "plugin__slack__search")]);
    expect(done?.status).toBe("done");
    expect(done?.waiting).toBeUndefined();
  });

  it("the question tool is kind question and previews the header, else the question, else the title", () => {
    expect(row([ask(1, QUESTIONS)])).toMatchObject({ kind: "question", keyArg: "数据库" });
    expect(row([ask(1, [{ question: "用哪个数据库？" }])])?.keyArg).toBe("用哪个数据库？");
    expect(row([ask(1, [])])?.keyArg).toBe("Ask the user");
    // before the display metadata arrives, from the key alone
    expect(row([ask(1, QUESTIONS)], new Map())).toMatchObject({
      kind: "question",
      keyArg: "数据库",
    });
    // an older key of the question tool (history logged before the rename)
    const legacy = new Map<string, ToolInfo>([
      ["legacy_ask", { ...ASK, key: "legacy_ask", aliasOf: "AskUserQuestion" }],
    ]);
    const old = calls(1, [{ id: "q", name: "legacy_ask", input: { questions: QUESTIONS } }]);
    expect(row([old], legacy)?.kind).toBe("question");
  });
});

describe("background sub-agents (agent map spec §5, §9.4)", () => {
  const dispatch = (kind?: "task" | "message") => ({
    dispatch: {
      parentConversationId: "c0",
      parentRunId: "r0",
      callId: "k1",
      ...(kind ? { kind } : {}),
    },
  });

  it("a parent message in a child renders as a bubble labelled with the parent", () => {
    const events = [
      user(1, "Scan the docs", dispatch()),
      ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      user(3, "Focus on the API docs", dispatch("message")),
    ];
    const out = buildTimeline(events, [], new Map(), "en", {
      agentName: (id) => (id === "c0" ? "Release notes" : undefined),
    });
    expect(kinds(out)).toEqual(["task", "user"]);
    expect(out[1]).toMatchObject({
      kind: "user",
      text: "Focus on the API docs",
      sender: { id: "c0", name: "Release notes" },
    });
    // without a name the sender is still the parent (the thread words it)
    const bare = buildTimeline(events, [], new Map(), "en");
    expect(bare[1]).toMatchObject({ kind: "user", sender: { id: "c0" } });
    expect(bare[1]).not.toHaveProperty("sender.name");
  });

  it("a subagent_delivery renders in the parent", () => {
    const delivery = (seq: number, payload: Record<string, unknown>) =>
      ev(
        seq,
        "subagent_delivery",
        {
          subagentId: "ch1",
          childRunId: "run-ch1",
          description: "Scan docs",
          triggerAccountId: "a1",
          text: "",
          ...payload,
        },
        null,
      );
    const events = [
      user(1, "go"),
      delivery(2, { kind: "report", text: "Docs are fine." }),
      delivery(3, { kind: "note", text: "Halfway there." }),
      delivery(4, { kind: "finished", status: "completed", handedBack: true }),
      delivery(5, { kind: "finished", status: "max_steps", text: "out of steps" }),
      delivery(6, { kind: "finished", status: "aborted", abortedBy: "user" }),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual([
      "user",
      "delivery",
      "delivery",
      "delivery",
      "delivery",
      "delivery",
    ]);
    expect(out.slice(1)).toMatchObject([
      { subagentId: "ch1", name: "Scan docs", delivery: "report", text: "Docs are fine." },
      { delivery: "note", text: "Halfway there." },
      { delivery: "finished", status: "completed", text: "" },
      { delivery: "finished", status: "failed", text: "out of steps" },
      { delivery: "finished", status: "aborted" },
    ]);
  });

  it("SendMessage and SubagentHandback are ordinary tool rows", () => {
    const events = [
      user(1, "go"),
      calls(2, [
        { id: "a", name: "SendMessage", input: { to: "parent", message: "Halfway" } },
        { id: "b", name: "SubagentHandback", input: { message: "All done" } },
      ]),
      result(3, "a", "SendMessage"),
      result(4, "b", "SubagentHandback"),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "tools"]);
    expect(tools(out)[0]?.rows.map((r) => [r.row.name, r.row.status])).toEqual([
      ["SendMessage", "done"],
      ["SubagentHandback", "done"],
    ]);
  });

  it("an unfinished sub-agent's row names its current tool from subagent_progress", () => {
    const events = [
      user(1, "go"),
      calls(2, [
        {
          id: "k1",
          name: "Agent",
          input: { description: "Scan docs", prompt: "Do it", subagent_type: "general-purpose" },
        },
      ]),
      ev(3, "subagent_dispatched", {
        step: 0,
        callId: "k1",
        subagentId: "ch1",
        childRunId: "run-ch1",
        agentType: "general-purpose",
        description: "Scan docs",
        resumed: false,
        model: { provider: "p", model: "m" },
      }),
    ];
    const out = buildTimeline(events, [], INFO, "en", {
      progress: { ch1: { toolCalls: 2, lastToolKey: "plugin__slack__search" } },
    });
    const g = out.find((e) => e.kind === "subagents");
    expect(g?.kind === "subagents" && g.rows[0]?.row.current).toBe("Slack [search]");
  });
});

describe("waits of nested sub-agents (agent map spec §7)", () => {
  const agentCall = calls(2, [
    {
      id: "k1",
      name: "Agent",
      input: { description: "Scan docs", prompt: "Do it", subagent_type: "general-purpose" },
    },
  ]);
  const dispatched = ev(3, "subagent_dispatched", {
    step: 0,
    callId: "k1",
    subagentId: "ch1",
    childRunId: "run-ch1",
    agentType: "general-purpose",
    description: "Scan docs",
    resumed: false,
    model: { provider: "p", model: "m" },
  });
  const deepWait = ev(4, "subagent_waiting", {
    subagentId: "gc1",
    childRunId: "run-gc1",
    path: ["ch1", "gc1"],
    kind: "connect",
    toolKey: "mcp__gh__issue",
  });
  const events = [user(1, "go"), agentCall, dispatched, deepWait];
  const rowOf = (out: TimelineEntry[]) => {
    const g = out.find((e) => e.kind === "subagents");
    return g?.kind === "subagents" ? g.rows[0]?.row : undefined;
  };

  it("a deep agent's wait marks its root-level row waiting and names the waiting agent", () => {
    const out = buildTimeline(events, [], new Map(), "en", {
      agentName: (id) => (id === "gc1" ? "Read the changelog" : undefined),
      // the list says the root's child itself runs: its descendant's wait still shows
      views: new Map([
        ["ch1", { status: "running", pendingApprovalIds: [], pendingQuestionIds: [] }],
      ]),
    });
    expect(rowOf(out)).toMatchObject({ id: "ch1", status: "waiting", waiting: "connect" });
    expect(out.at(-1)).toMatchObject({
      kind: "subagent-wait",
      subagent: { id: "gc1", name: "Read the changelog" },
      deep: true,
      wait: "connect",
    });
  });

  it("without the agent's name a deep wait is named by its branch, never by a bare id", () => {
    const out = buildTimeline(events, [], new Map(), "en");
    expect(out.at(-1)).toMatchObject({ subagent: { id: "gc1", name: "Scan docs" } });
  });

  it("the tree says the deep agent goes on: the row is no longer waiting", () => {
    const out = buildTimeline(events, [], new Map(), "en", {
      agentStatus: (id) => (id === "gc1" ? "running" : undefined),
    });
    expect(rowOf(out)).toMatchObject({ status: "running" });
    expect(rowOf(out)).not.toHaveProperty("waiting");
  });

  it("only a background row names its current tool (a fork's child is foreground)", () => {
    const fork = [
      user(1, "/review", {
        skill: {
          id: "s1",
          version: 1,
          source: "org",
          name: "review",
          arguments: "",
          mode: "fork",
        },
      }),
      ev(2, "subagent_dispatched", {
        step: 0,
        callId: "skill-1",
        subagentId: "ch9",
        childRunId: "run-ch9",
        agentType: "general-purpose",
        description: "review",
        resumed: false,
        model: { provider: "p", model: "m" },
        invokedSeq: 1,
      }),
    ];
    const out = buildTimeline(fork, [], new Map(), "en", {
      progress: { ch9: { toolCalls: 1, lastToolKey: "Bash" } },
    });
    expect(rowOf(out)).toMatchObject({ id: "ch9", background: false });
    expect(rowOf(out)).not.toHaveProperty("current");
  });
});

describe("Agent call rows across a child's runs (final review)", () => {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 };
  const agentCall = calls(2, [
    {
      id: "k1",
      name: "Agent",
      input: { description: "Scan docs", prompt: "Do it", subagent_type: "general-purpose" },
    },
  ]);
  const dispatched = (seq: number, callId: string, childRunId: string, runId = "r1") =>
    ev(
      seq,
      "subagent_dispatched",
      {
        step: 0,
        callId,
        subagentId: "ch1",
        childRunId,
        agentType: "general-purpose",
        description: "Scan docs",
        resumed: callId !== "k1",
        model: { provider: "p", model: "m" },
      },
      runId,
    );
  const finished = (seq: number, childRunId: string, status = "completed", u = usage) =>
    ev(
      seq,
      "subagent_finished",
      {
        subagentId: "ch1",
        childRunId,
        callId: "k1",
        status,
        toolCalls: 3,
        durationMs: 41_000,
        usage: u,
      },
      null,
    );
  const rowOf = (out: TimelineEntry[]) => {
    const g = out.find((e) => e.kind === "subagents");
    return g?.kind === "subagents" ? g.rows[0]?.row : undefined;
  };

  it("an ended call shows its child's tokens (the four usage fields summed)", () => {
    const events = [user(1, "go"), agentCall, dispatched(3, "k1", "run-a"), finished(4, "run-a")];
    expect(rowOf(buildTimeline(events, [], new Map(), "en"))).toMatchObject({
      status: "completed",
      durationMs: 41_000,
      tokens: 1500,
    });
  });

  it("a child restarted by SendMessage runs again on its Agent call's row, then ends again", () => {
    const base = [
      user(1, "go"),
      agentCall,
      dispatched(3, "k1", "run-a"),
      result(4, "k1", "Agent"),
      finished(5, "run-a"),
      user(6, "tell it more"),
      calls(7, [{ id: "sm1", name: "SendMessage", input: { to: "ch1", message: "more" } }]),
      // the restart carries the SendMessage call's id, not the Agent call's
      dispatched(8, "sm1", "run-b"),
    ];
    const running = rowOf(buildTimeline(base, [], new Map(), "en"));
    expect(running).toMatchObject({ id: "ch1", status: "running" });
    expect(running).not.toHaveProperty("durationMs");
    expect(running).not.toHaveProperty("finishedAt");
    expect(running).not.toHaveProperty("tokens");
    const again = [
      ...base,
      finished(9, "run-b", "failed", {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ];
    expect(rowOf(buildTimeline(again, [], new Map(), "en"))).toMatchObject({
      status: "failed",
      tokens: 15,
    });
  });

  it("a child woken by its own background task: the list's newer run reopens the row", () => {
    const events = [
      user(1, "go"),
      agentCall,
      dispatched(3, "k1", "run-a"),
      result(4, "k1", "Agent"),
      finished(5, "run-a"),
    ];
    const endedAt = Date.parse(events[4]?.createdAt ?? "");
    const view = (startedAt: number) =>
      new Map([
        [
          "ch1",
          {
            status: "running",
            startedAt: new Date(startedAt).toISOString(),
            pendingApprovalIds: [],
            pendingQuestionIds: [],
          },
        ],
      ]);
    // the list was read before the finish: the log wins
    expect(
      rowOf(buildTimeline(events, [], new Map(), "en", { views: view(endedAt - 30_000) })),
    ).toMatchObject({ status: "completed" });
    // a run that started after the finish (a wake writes no dispatch)
    const woken = rowOf(buildTimeline(events, [], new Map(), "en", { views: view(endedAt + 5000) }));
    expect(woken).toMatchObject({ status: "running" });
    expect(woken).not.toHaveProperty("durationMs");
    // the wake run's own finish is the row's latest end
    const after = [
      ...events,
      finished(6, "run-w", "completed", {
        inputTokens: 7,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ];
    expect(rowOf(buildTimeline(after, [], new Map(), "en"))).toMatchObject({
      status: "completed",
      tokens: 7,
    });
  });
});
