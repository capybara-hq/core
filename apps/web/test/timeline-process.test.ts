import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import {
  groupProcess,
  type ProcessEntry,
  parseTaskList,
  railItems,
  sectionRail,
  type ThreadEntry,
} from "../src/lib/process";
import { buildTimeline, type TimelineDraft, type TimelineEntry } from "../src/lib/timeline";

// Log fixtures: the same helpers as timeline.test.ts.
let t = 0;
const req = (seq: number) => ({ absorbedUpToSeq: seq, tools: [] });

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
const step = (seq: number, content: unknown[], s = 0) =>
  ev(seq, "assistant_message", { step: s, stopReason: "end_turn", content });
const answer = (seq: number, text: string) => step(seq, [{ type: "text", text }]);
const result = (
  seq: number,
  callId: string,
  toolKey: string,
  extra: Record<string, unknown> = {},
) => ev(seq, "tool_result", { step: 0, callId, toolKey, content: "ok", isError: false, ...extra });
const runStarted = (seq: number) =>
  ev(seq, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } });
const runFinished = (seq: number) =>
  ev(seq, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 });
const bash = (id: string, command = "ls") => ({ id, name: "Bash", input: { command } });

const INFO = new Map<string, ToolInfo>([
  [
    "Bash",
    {
      key: "Bash",
      title: null,
      kind: "command",
      icon: { kind: "name", name: "terminal" },
      sandbox: true,
      keyArgs: ["command"],
      inputView: { kind: "command", command: "command", description: "description" },
      tool: null,
      source: { kind: "builtin" },
    },
  ],
]);

const build = (events: ConversationEvent[], drafts: TimelineDraft[] = []): ThreadEntry[] =>
  groupProcess(buildTimeline(events, drafts, INFO, "en"));
const kinds = (entries: readonly { kind: string }[]) => entries.map((e) => e.kind);
const blocks = (entries: ThreadEntry[]) =>
  entries.filter((e): e is ProcessEntry => e.kind === "process");
const block = (entries: ThreadEntry[], i = 0): ProcessEntry => {
  const b = blocks(entries)[i];
  if (b === undefined) throw new Error(`no process block ${i}`);
  return b;
};

describe("groupProcess", () => {
  it("narration vs answer", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")], "Let me look first."),
      result(4, "a", "Bash"),
      answer(5, "Here it is."),
      runFinished(6),
    ];
    const timeline = buildTimeline(events, [], INFO, "en");
    const prose = timeline.filter(
      (e): e is Extract<TimelineEntry, { kind: "prose" }> => e.kind === "prose",
    );
    expect(prose.map((p) => [p.text, p.narration])).toEqual([
      ["Let me look first.", true],
      ["Here it is.", false],
    ]);

    const out = groupProcess(timeline);
    expect(kinds(out)).toEqual(["user", "process", "prose", "run"]);
    const b = block(out);
    expect(kinds(b.steps)).toEqual(["narration", "tools"]);
    expect(b.steps[0]).toMatchObject({ text: "Let me look first.", streaming: false });
    expect(b).toMatchObject({ runId: "r1", state: "finished", backgroundRunning: 0 });
    expect(b.durationMs).toEqual(expect.any(Number));
    expect(out[2]).toMatchObject({ kind: "prose", text: "Here it is.", narration: false });
  });

  it("streamed narration moves into the open block", () => {
    const base = [user(1, "go"), runStarted(2), calls(3, [bash("a")]), result(4, "a", "Bash")];
    const draft: TimelineDraft = {
      runId: "r1",
      step: 1,
      text: "Now the next file",
      thinking: "",
      tools: [],
    };

    // the step streams its text: drawn as prose under the block, which is still running
    const streaming = build(base, [draft]);
    expect(kinds(streaming)).toEqual(["user", "process", "prose"]);
    expect(streaming[2]).toMatchObject({ streaming: true, narration: false });
    expect(block(streaming).state).toBe("running");

    // its first tool call arrives (streamed): the text, now written, moves into the block, and the
    // call streams after it as the logged step will draw it
    const withCall = build(base, [
      { ...draft, tools: [{ id: "b", name: "Bash", input: '{"command":"l' }] },
    ]);
    expect(kinds(withCall)).toEqual(["user", "process"]);
    expect(kinds(block(withCall).steps)).toEqual(["tools", "narration", "tools"]);
    expect(block(withCall).steps[1]).toMatchObject({ text: "Now the next file", streaming: false });
    const streamed = block(withCall).steps[2] as Extract<TimelineEntry, { kind: "tools" }>;
    expect(streamed.rows.map((r) => r.row.status)).toEqual(["streaming"]);

    // the step lands in the log (a reload mid-step reads the same): the same block, no second move
    const landed = build([
      ...base,
      step(
        5,
        [
          { type: "text", text: "Now the next file" },
          { type: "tool_call", ...bash("b") },
        ],
        1,
      ),
    ]);
    expect(kinds(landed)).toEqual(["user", "process"]);
    expect(kinds(block(landed).steps)).toEqual(["tools", "narration", "tools"]);
    expect(block(landed).steps[1]).toMatchObject({ streaming: false });
    expect(block(landed).key).toBe(block(withCall).key);
    // the streamed call's group and row keep their keys as the logged ones (streaming spec D8)
    const loggedCall = block(landed).steps[2] as Extract<TimelineEntry, { kind: "tools" }>;
    expect(loggedCall.key).toBe(streamed.key);
    expect(loggedCall.rows.map((r) => r.row.id)).toEqual(streamed.rows.map((r) => r.row.id));
    expect(loggedCall.rows[0]?.step).toEqual(streamed.rows[0]?.step);
    expect(block(landed).key).toBe(block(streaming).key);

    // a block whose first step is a thinking draft keeps its key when that step lands
    const start = [user(1, "go"), runStarted(2)];
    const thinking = build(start, [
      { runId: "r1", step: 0, text: "", thinking: "plan", tools: [] },
    ]);
    expect(kinds(thinking)).toEqual(["user", "process"]);
    expect(kinds(block(thinking).steps)).toEqual(["thinking"]);
    const logged = build([
      ...start,
      step(3, [
        { type: "thinking", text: "plan" },
        { type: "tool_call", ...bash("a") },
      ]),
    ]);
    expect(kinds(block(logged).steps)).toEqual(["thinking", "tools"]);
    expect(block(logged).key).toBe(block(thinking).key);
  });

  it("one block across thinking, tools, narration", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      step(3, [
        { type: "thinking", text: "plan" },
        { type: "tool_call", ...bash("a") },
      ]),
      result(4, "a", "Bash"),
      calls(5, [bash("b", "pwd")], "Reading the folder."),
      result(6, "b", "Bash"),
      step(7, [
        { type: "thinking", text: "done" },
        { type: "text", text: "All set." },
      ]),
      runFinished(8),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "prose", "run"]);
    expect(kinds(block(out).steps)).toEqual([
      "thinking",
      "tools",
      "narration",
      "tools",
      "thinking",
    ]);
  });

  it("queued user message splits the block", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      ev(3, "model_call", { step: 0, provider: "p", model: "m", request: req(1) }),
      calls(4, [bash("a")]),
      result(5, "a", "Bash"),
      user(6, "also check the logs"),
      ev(7, "model_call", { step: 1, provider: "p", model: "m", request: req(6) }),
      calls(8, [bash("b", "tail log")]),
      result(9, "b", "Bash"),
      answer(10, "Both done."),
      runFinished(11),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "user", "process", "prose", "run"]);
    expect(blocks(out).map((b) => b.state)).toEqual(["finished", "finished"]);
    expect(blocks(out).map((b) => b.runId)).toEqual(["r1", "r1"]);
  });

  it("parallel sub-agents end the block, a single sync one is a step", () => {
    const agent = (id: string, description: string) => ({
      id,
      name: "Agent",
      input: { description, prompt: "p" },
    });
    const dispatched = (seq: number, callId: string, subagentId: string) =>
      ev(seq, "subagent_dispatched", {
        step: 0,
        callId,
        subagentId,
        childRunId: `run-${subagentId}`,
        agentType: "general-purpose",
        description: "d",
        resumed: false,
        model: { provider: "p", model: "m" },
      });
    const finished = (seq: number, callId: string, subagentId: string) =>
      ev(
        seq,
        "subagent_finished",
        {
          subagentId,
          childRunId: `run-${subagentId}`,
          callId,
          status: "completed",
          toolCalls: 1,
          durationMs: 1000,
        },
        null,
      );

    // two in one step: their group stands outside and ends the block
    const parallel = build([
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")]),
      result(4, "a", "Bash"),
      calls(5, [agent("k1", "one"), agent("k2", "two")]),
      calls(6, [bash("b")]),
    ]);
    expect(kinds(parallel)).toEqual(["user", "process", "subagents", "process"]);
    expect(block(parallel, 0).state).toBe("finished");
    expect(block(parallel, 1).state).toBe("running");

    // one in the background (its call's result came at dispatch): outside, ends the block too
    const background = build([
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")]),
      result(4, "a", "Bash"),
      calls(5, [agent("k1", "one")]),
      dispatched(6, "k1", "ch1"),
      result(7, "k1", "Agent"),
    ]);
    expect(kinds(background)).toEqual(["user", "process", "subagents"]);

    // one synchronous (it finished before its call's result): a rail step
    const sync = build([
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")]),
      result(4, "a", "Bash"),
      calls(5, [agent("k1", "one")]),
      dispatched(6, "k1", "ch1"),
      finished(7, "k1", "ch1"),
      result(8, "k1", "Agent"),
      answer(9, "Done."),
      runFinished(10),
    ]);
    expect(kinds(sync)).toEqual(["user", "process", "prose", "run"]);
    expect(kinds(block(sync).steps)).toEqual(["tools", "subagent"]);
    expect(block(sync).steps[1]).toMatchObject({ row: { callId: "k1", row: { id: "ch1" } } });
  });

  it("fallback inside a run is a note step", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")]),
      result(4, "a", "Bash"),
      ev(5, "model_switched", {
        model: null,
        effort: null,
        byAccountId: null,
        reason: "unavailable",
      }),
      calls(6, [bash("b")]),
      result(7, "b", "Bash"),
      answer(8, "Done."),
      runFinished(9),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "prose", "run"]);
    expect(kinds(block(out).steps)).toEqual(["tools", "note", "tools"]);
    expect(block(out).steps[1]).toMatchObject({
      note: "fallback",
      divider: { divider: "fallback" },
    });
  });

  it("approval waits outside, decided becomes a step", () => {
    const waiting = [
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a", "rm x")]),
      ev(4, "approval_requested", {
        step: 0,
        callId: "a",
        approvalId: "ap1",
        toolKey: "Bash",
        expiresAt: "x",
      }),
    ];
    const open = build(waiting);
    expect(kinds(open)).toEqual(["user", "process", "approval"]);
    expect(block(open).state).toBe("waiting");

    const decided = build([
      ...waiting,
      ev(5, "approval_decided", {
        approvalId: "ap1",
        callId: "a",
        decision: "approved",
        byAccountId: "a1",
      }),
      result(6, "a", "Bash"),
      answer(7, "Removed."),
      runFinished(8),
    ]);
    expect(kinds(decided)).toEqual(["user", "process", "prose", "run"]);
    expect(kinds(block(decided).steps)).toEqual(["tools", "decided"]);
    expect(block(decided).steps[1]).toMatchObject({
      entry: { kind: "approval", item: { approvalId: "ap1", decided: { decision: "approved" } } },
    });
    expect(block(decided).state).toBe("finished");
  });

  it("stopped while waiting", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [{ id: "td", name: "plugin__todo__write", input: {} }]),
      result(4, "td", "plugin__todo__write", {
        card: { plugin: "todo", view: "tasks", placement: "pinned", text: "- [ ] a" },
      }),
      calls(5, [bash("a", "rm x")]),
      ev(6, "approval_requested", {
        step: 0,
        callId: "a",
        approvalId: "ap1",
        toolKey: "Bash",
        expiresAt: "x",
      }),
      ev(7, "run_aborted", { byAccountId: "a1", reason: "user" }),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "card", "approval", "run"]);
    const b = block(out);
    expect(b.state).toBe("stopped");
    expect(b.pinned).toEqual([]);
    expect(out[2]).toMatchObject({ kind: "card", plugin: "todo", placement: "pinned" });
    expect(out[3]).toMatchObject({ kind: "approval", item: { decided: null } });
  });

  it("two handoffs merge into one pending entry", () => {
    const view = (en: string) => ({
      kind: "handoff" as const,
      title: { zh: en, en },
      target: { type: "connect" as const, connectorId: "app1" },
    });
    const platform = (id: string) => ({ id, name: "Platform", input: { action: "call" } });
    const events = [
      user(1, "set up"),
      runStarted(2),
      calls(3, [platform("p1"), platform("p2")]),
      result(4, "p1", "Platform", { view: view("Connect Docs") }),
      result(5, "p2", "Platform", { view: view("Connect Mail") }),
      answer(6, "Two things for you."),
      runFinished(7),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "pending", "prose", "run"]);
    const pending = out[2];
    expect(pending?.kind === "pending" && pending.items.map((i) => i.callId)).toEqual(["p1", "p2"]);

    // one turn split by a sub-agent group and a queued message: still one pending entry, after
    // the blocking cards of the turn's last block
    const agent = (id: string) => ({ id, name: "Agent", input: { description: id, prompt: "p" } });
    const split = build([
      user(1, "set up"),
      runStarted(2),
      ev(3, "model_call", { step: 0, provider: "p", model: "m", request: req(1) }),
      calls(4, [platform("p1")]),
      result(5, "p1", "Platform", { view: view("Connect Docs") }),
      calls(6, [agent("k1"), agent("k2")]),
      user(7, "and mail"),
      ev(8, "model_call", { step: 1, provider: "p", model: "m", request: req(7) }),
      calls(9, [platform("p2")]),
      result(10, "p2", "Platform", { view: view("Connect Mail") }),
      calls(11, [bash("x", "rm x")]),
      ev(12, "approval_requested", {
        step: 0,
        callId: "x",
        approvalId: "ap1",
        toolKey: "Bash",
        expiresAt: "x",
      }),
    ]);
    expect(kinds(split)).toEqual([
      "user",
      "process",
      "subagents",
      "user",
      "process",
      "approval",
      "pending",
    ]);
    const merged = split.at(-1);
    expect(merged?.kind === "pending" && merged.items.map((i) => i.callId)).toEqual(["p1", "p2"]);

    // the next turn's handoffs are a pending entry of their own
    const next = build([
      ...events,
      user(8, "again"),
      runStarted(9),
      calls(10, [platform("p3")]),
      result(11, "p3", "Platform", { view: view("Connect Chat") }),
      answer(12, "One more."),
      runFinished(13),
    ]);
    expect(kinds(next).filter((k) => k === "pending")).toHaveLength(2);
  });

  it("order outside: block, blocking, pending, files, answer", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [
        bash("a", "make report"),
        { id: "p", name: "Platform", input: { action: "call" } },
        bash("g", "gh auth login --web"),
      ]),
      ev(4, "artifact_created", {
        callId: "a",
        artifactId: "f1",
        name: "report.pdf",
        contentType: "application/pdf",
        size: 10,
        sourcePath: "/w/report.pdf",
      }),
      result(5, "a", "Bash", { card: { plugin: "charts", view: "chart" } }),
      result(6, "p", "Platform", {
        view: {
          kind: "handoff",
          title: { zh: "x", en: "Connect Docs" },
          target: { type: "connect", connectorId: "app1" },
        },
      }),
      ev(7, "device_code", { callId: "g", url: "https://github.com/login/device", code: "AB-12" }),
      result(8, "g", "Bash"),
      answer(9, "Report ready."),
      runFinished(10),
    ];
    // the device code's call is still running: it waits for the person, outside the block
    const live = build(events.slice(0, 7));
    expect(kinds(live)).toEqual(["user", "process", "device-code", "pending", "files", "card"]);
    expect(block(live).state).toBe("waiting");

    // its call ended (the code was used): it folds into the rail like a decided approval
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "pending", "files", "card", "prose", "run"]);
    expect(kinds(block(out).steps)).toEqual(["tools", "decided"]);
  });

  it("pinned keeps the latest per view", () => {
    const todo = (seq: number, id: string) => [
      calls(seq, [{ id, name: "plugin__todo__write", input: {} }]),
      result(seq + 1, id, "plugin__todo__write", {
        card: { plugin: "todo", view: "tasks", placement: "pinned", key: id },
      }),
    ];
    const one = build([user(1, "go"), runStarted(2), ...todo(3, "t1"), ...todo(5, "t2")]);
    expect(kinds(one)).toEqual(["user", "process"]);
    expect(block(one).pinned).toMatchObject([{ plugin: "todo", view: "tasks", cardKey: "t2" }]);
    expect(kinds(block(one).steps)).toEqual(["tools"]);

    // two views: both kept, each its latest, in first-seen order
    const plan = (seq: number, id: string) => [
      calls(seq, [{ id, name: "plugin__plan__write", input: {} }]),
      result(seq + 1, id, "plugin__plan__write", {
        card: { plugin: "plan", view: "steps", placement: "pinned", key: id },
      }),
    ];
    const two = build([
      user(1, "go"),
      runStarted(2),
      ...todo(3, "t1"),
      ...plan(5, "s1"),
      ...todo(7, "t2"),
      ...plan(9, "s2"),
    ]);
    expect(block(two).pinned.map((c) => [c.plugin, c.cardKey])).toEqual([
      ["todo", "t2"],
      ["plan", "s2"],
    ]);

    // a queued message splits the run's block: the run's latest card lives on its latest block
    const split = build([
      user(1, "go"),
      runStarted(2),
      ev(3, "model_call", { step: 0, provider: "p", model: "m", request: req(1) }),
      ...todo(4, "t1"),
      user(6, "and one more"),
      ev(7, "model_call", { step: 1, provider: "p", model: "m", request: req(6) }),
      ...todo(8, "t2"),
      answer(10, "Done."),
      runFinished(11),
    ]);
    expect(kinds(split)).toEqual(["user", "process", "user", "process", "prose", "run"]);
    expect(block(split, 0).pinned).toEqual([]);
    expect(block(split, 1).pinned).toMatchObject([{ cardKey: "t2" }]);
  });

  it("pinned stays outside after a failed run", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [{ id: "td", name: "plugin__todo__write", input: {} }]),
      result(4, "td", "plugin__todo__write", {
        card: { plugin: "todo", view: "tasks", placement: "pinned" },
      }),
      ev(5, "run_failed", { error: { code: "model.timeout", message: "x" } }),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "card", "run"]);
    expect(block(out)).toMatchObject({ state: "failed" });
    expect(block(out).pinned).toEqual([]);

    // a finished run keeps it on the block
    const ok = build([...events.slice(0, 4), answer(5, "Done."), runFinished(6)]);
    expect(kinds(ok)).toEqual(["user", "process", "prose", "run"]);
    expect(block(ok).pinned).toMatchObject([{ plugin: "todo", view: "tasks" }]);

    // a split run that fails: every block takes the end, the pinned card (on the first block,
    // the second wrote none) stands outside
    const split = build([
      user(1, "go"),
      runStarted(2),
      ev(3, "model_call", { step: 0, provider: "p", model: "m", request: req(1) }),
      calls(4, [{ id: "td", name: "plugin__todo__write", input: {} }]),
      result(5, "td", "plugin__todo__write", {
        card: { plugin: "todo", view: "tasks", placement: "pinned" },
      }),
      user(6, "and more"),
      ev(7, "model_call", { step: 1, provider: "p", model: "m", request: req(6) }),
      calls(8, [bash("b")]),
      result(9, "b", "Bash"),
      ev(10, "run_failed", { error: { code: "model.timeout", message: "x" } }),
    ]);
    expect(kinds(split)).toEqual(["user", "process", "card", "user", "process", "run"]);
    expect(blocks(split).map((b) => b.state)).toEqual(["failed", "failed"]);
    expect(blocks(split).map((b) => b.durationMs === null)).toEqual([true, false]);
  });

  it("log without placement", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a"), bash("b")]),
      result(4, "a", "Bash", { card: { plugin: "charts", view: "chart" } }),
      result(5, "b", "Bash", { card: { plugin: "diff", view: "diff", placement: "process" } }),
      answer(6, "Done."),
      runFinished(7),
    ];
    const timeline = buildTimeline(events, [], INFO, "en");
    const cards = timeline.filter((e) => e.kind === "card");
    expect(cards.map((c) => c.kind === "card" && c.placement)).toEqual(["output", "process"]);

    const out = groupProcess(timeline);
    // the card without a placement is an output card, after the block
    expect(kinds(out)).toEqual(["user", "process", "card", "prose", "run"]);
    expect(out[2]).toMatchObject({ plugin: "charts", placement: "output" });
    // a process card stays in the rail after its tools step
    expect(kinds(block(out).steps)).toEqual(["tools", "card"]);
    expect(block(out).steps[1]).toMatchObject({ plugin: "diff" });
  });

  it("a finished run without an answer after its last narration draws it as the answer", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [bash("a")], "Looking first."),
      result(4, "a", "Bash"),
      ev(5, "assistant_message", {
        step: 1,
        stopReason: "tool_use",
        content: [
          { type: "text", text: "All **done**." },
          { type: "tool_call", ...bash("b") },
        ],
      }),
      result(6, "b", "Bash"),
      step(7, [], 2),
      runFinished(8),
    ];
    const out = build(events);
    expect(kinds(out)).toEqual(["user", "process", "prose", "run"]);
    // still a narration step in the block, and the answer after it
    expect(block(out).steps.filter((x) => x.kind === "narration")).toHaveLength(2);
    expect(out[2]).toMatchObject({ kind: "prose", text: "All **done**.", narration: false });
    expect(out[2]?.key).not.toBe(block(out).steps[2]?.key);

    // an answer after the narration: nothing promoted
    const answered = build([...events.slice(0, 6), answer(7, "Here."), runFinished(8)]);
    expect(kinds(answered)).toEqual(["user", "process", "prose", "run"]);
    expect(answered[2]).toMatchObject({ text: "Here." });

    // a failed run keeps its narration in the block only
    const failed = build([
      ...events.slice(0, 6),
      ev(7, "run_failed", { error: { code: "model.timeout", message: "x" } }),
    ]);
    expect(kinds(failed)).toEqual(["user", "process", "run"]);
  });

  it("a connect card stays outside, with its Connect, until the run ends", () => {
    const connector = {
      id: "c9",
      name: "mcp__docs__read",
      input: {},
    };
    const head = [
      user(1, "read my docs"),
      runStarted(2),
      calls(3, [connector]),
      ev(4, "connection_required", { callId: "c9", appId: "app1", appName: "Docs" }),
      // the call went on with the connect text as its result: the person has not connected
      result(5, "c9", "mcp__docs__read", { isError: true, content: "not connected" }),
      answer(6, "Please connect Docs, then retry."),
    ];
    // the answer is in but the run goes on: the card still offers Connect, outside the block
    const going = build(head);
    expect(kinds(going)).toEqual(["user", "process", "connect", "prose"]);
    expect(going[2]).toMatchObject({ kind: "connect", item: { closed: false } });
    expect(kinds(block(going).steps)).toEqual(["tools"]);

    // the run ended: the card no longer offers Connect and folds into the rail
    const ended = build([...head, runFinished(7)]);
    expect(kinds(ended)).toEqual(["user", "process", "prose", "run"]);
    expect(kinds(block(ended).steps)).toEqual(["tools", "decided"]);
  });

  it("a sub-agent's wait stays outside while it waits and folds once it ended", () => {
    const agent = {
      id: "k1",
      name: "Agent",
      input: { description: "Scan docs", prompt: "Do it", subagent_type: "general-purpose" },
    };
    const head = [
      user(1, "go"),
      runStarted(2),
      calls(3, [agent]),
      ev(4, "subagent_dispatched", {
        step: 0,
        callId: "k1",
        subagentId: "ch1",
        childRunId: "run-ch1",
        agentType: "general-purpose",
        description: "Scan docs",
        resumed: false,
        model: { provider: "p", model: "m" },
      }),
      ev(5, "subagent_waiting", {
        subagentId: "ch1",
        childRunId: "run-ch1",
        kind: "approval",
        approvalId: "ap1",
        toolKey: "Bash",
      }),
    ];
    const waiting = build(head);
    const wait = waiting.find((e) => e.kind === "subagent-wait");
    expect(wait).toMatchObject({ kind: "subagent-wait", subagent: { id: "ch1" } });
    expect(wait !== undefined && "ended" in wait).toBe(false);

    // the child finished (its approval decided, its work done): the wait is a rail row
    const ended = build([
      ...head,
      ev(6, "subagent_finished", {
        subagentId: "ch1",
        childRunId: "run-ch1",
        status: "completed",
        toolCalls: 1,
        durationMs: 10,
      }),
      result(7, "k1", "Agent"),
      answer(8, "Scanned."),
      runFinished(9),
    ]);
    expect(kinds(ended)).toEqual(["user", "process", "prose", "run"]);
    const steps = block(ended).steps;
    expect(kinds(steps)).toEqual(["subagent", "decided"]);
    expect(steps[1]).toMatchObject({ entry: { kind: "subagent-wait", ended: true } });
  });

  it("an earlier wait of the same sub-agent ended when a later one came", () => {
    const wait = (seq: number, approvalId: string) =>
      ev(seq, "subagent_waiting", {
        subagentId: "ch1",
        childRunId: "run-ch1",
        kind: "approval",
        approvalId,
        toolKey: "Bash",
      });
    const events = [
      user(1, "go"),
      runStarted(2),
      calls(3, [{ id: "k1", name: "Agent", input: { description: "d", prompt: "p" } }]),
      ev(4, "subagent_dispatched", {
        step: 0,
        callId: "k1",
        subagentId: "ch1",
        childRunId: "run-ch1",
        agentType: "general-purpose",
        description: "d",
        resumed: false,
        model: { provider: "p", model: "m" },
      }),
      wait(5, "ap1"),
      wait(6, "ap2"),
    ];
    const waits = buildTimeline(events, [], INFO, "en").filter((e) => e.kind === "subagent-wait");
    expect(waits.map((w) => w.kind === "subagent-wait" && w.ended === true)).toEqual([true, false]);
  });
});

describe("rail sections by task list item (#924)", () => {
  const list = (...items: [string, "done" | "doing" | "open"][]) =>
    [
      "Todos:",
      "",
      ...items.map(([label, st]) =>
        st === "done"
          ? `- [x] ${label}`
          : st === "doing"
            ? `- [ ] **${label}** (in progress)`
            : `- [ ] ${label}`,
      ),
    ].join("\n");
  // each call its own model step (one rail row each)
  const stepCall = (seq: number, c: { id: string; name: string; input: unknown }) =>
    ev(seq, "assistant_message", {
      step: seq,
      stopReason: "tool_use",
      content: [{ type: "tool_call", ...c }],
    });
  const todo = (seq: number, id: string, text: string) => [
    stepCall(seq, { id, name: "plugin__todo__write", input: {} }),
    result(seq + 1, id, "plugin__todo__write", {
      card: { plugin: "todo", view: "tasks", placement: "pinned", key: id, text },
    }),
  ];
  const work = (seq: number, id: string) => [stepCall(seq, bash(id)), result(seq + 1, id, "Bash")];
  const sectionsOf = (b: ProcessEntry) =>
    sectionRail(railItems(b, () => true).items, b.taskLists).map((s) => ({
      task: s.task,
      steps: s.items.length,
    }));

  it("parses a Markdown task list, emphasis and the in-progress suffix removed", () => {
    expect(parseTaskList(list(["Read", "done"], ["Write", "doing"], ["Ship", "open"]))).toEqual([
      { label: "Read", done: true },
      { label: "Write", done: false },
      { label: "Ship", done: false },
    ]);
    expect(parseTaskList("no list here")).toBeNull();
    expect(parseTaskList(undefined)).toBeNull();
  });

  it("each step goes under the item current when it ran; done items are done", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      ...work(3, "w0"),
      ...todo(5, "t1", list(["Read", "doing"], ["Write", "open"])),
      ...work(7, "w1"),
      ...work(9, "w2"),
      // the step that marks Read done ran under Read
      ...todo(11, "t2", list(["Read", "done"], ["Write", "doing"])),
      ...work(13, "w3"),
      ...todo(15, "t3", list(["Read", "done"], ["Write", "done"])),
      answer(17, "Done."),
      runFinished(18),
    ];
    const b = block(build(events));
    expect(b.taskLists.cards.map((c) => c.cardKey)).toEqual(["t1", "t2", "t3"]);
    expect(sectionsOf(b)).toEqual([
      // before the first list: no item
      { task: null, steps: 2 },
      { task: { index: 0, label: "Read", done: true }, steps: 3 },
      { task: { index: 1, label: "Write", done: true }, steps: 2 },
    ]);
  });

  it("a running item is not done; a block with no list is one section", () => {
    const running = block(
      build([
        user(1, "go"),
        runStarted(2),
        ...todo(3, "t1", list(["Read", "doing"], ["Write", "open"])),
        ...work(5, "w1"),
      ]),
    );
    expect(sectionsOf(running).map((s) => s.task)).toEqual([
      null,
      { index: 0, label: "Read", done: false },
    ]);

    const plain = block(build([user(1, "go"), runStarted(2), ...work(3, "w1"), ...work(5, "w2")]));
    expect(sectionsOf(plain)).toEqual([{ task: null, steps: 2 }]);
  });

  it("a block split by a queued message starts under the run's current item", () => {
    const events = [
      user(1, "go"),
      runStarted(2),
      ev(3, "model_call", { step: 0, provider: "p", model: "m", request: req(1) }),
      ...todo(4, "t1", list(["Read", "doing"], ["Write", "open"])),
      user(6, "and one more"),
      ev(7, "model_call", { step: 1, provider: "p", model: "m", request: req(6) }),
      ...work(8, "w1"),
      ...todo(10, "t2", list(["Read", "done"], ["Write", "done"])),
      answer(12, "Done."),
      runFinished(13),
    ];
    const out = build(events);
    const second = block(out, 1);
    expect(second.taskLists.cards.map((c) => c.cardKey)).toEqual(["t1", "t2"]);
    expect(sectionsOf(second)).toEqual([
      { task: { index: 0, label: "Read", done: true }, steps: 2 },
    ]);
    // the earlier block sees the run's latest list too: its Read section is done
    expect(block(out, 0).taskLists.latest?.cardKey).toBe("t2");
  });
});
