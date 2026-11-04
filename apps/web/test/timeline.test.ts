import { summarizeTools } from "@capybara-hq/design";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import {
  buildEventTimeline,
  buildTimeline,
  latestUsage,
  runStats,
  type TimelineEntry,
  withDrafts,
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
    expect(kinds(out)).toEqual(["user", "tools"]);
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

  it("run_aborted → a stopped divider with who; a model.request denial names the extension", () => {
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
    expect(out[0]).toMatchObject({ kind: "divider", divider: "stopped", byAccountId: "a1" });
    expect(out[1]).toMatchObject({
      kind: "divider",
      divider: "hook-denied",
      plugin: "guard",
      reason: "pii",
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

  it("a retry folds into the failed divider instead of a second bubble", () => {
    const events = [
      user(1, "hello"),
      ev(2, "run_failed", { error: { code: "model.timeout", message: "x" } }),
      user(3, "hello", { retryOf: 1 }),
    ];
    const out = buildTimeline(events, [], new Map(), "en");
    expect(kinds(out)).toEqual(["user", "divider"]);
    expect(out[1]).toMatchObject({
      divider: "failed",
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
      divider: "failed",
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
