import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import { liveWriteDiff } from "../src/lib/live-diff";
import { groupProcess, type ProcessEntry } from "../src/lib/process";
import type { DraftTool } from "../src/lib/run-drafts";
import { initialChatState, reduceChat, type StreamDelta } from "../src/lib/stream";
import {
  COMMAND_KEY_ARG_MAX_CHARS,
  INPUT_VALUE_MAX_CHARS,
  LIVE_LINE_MAX_CHARS,
  LIVE_MAX_LINES,
  LIVE_TEXT_MAX_CHARS,
  liveTextTail,
  loggedLiveStats,
  utf8Bytes,
} from "../src/lib/streaming-tool-view";
import {
  buildEventTimeline,
  buildTimeline,
  streamedToolKeys,
  type TimelineDraft,
  type TimelineEntry,
  type TimelineTool,
  withDrafts,
  workingLineVisible,
} from "../src/lib/timeline";

// Streaming tool input spec §6.2 / §6.4: a draft's streamed calls are streaming rows.

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
const asked: ConversationEvent[] = [
  ev(1, "user_message", { content: [{ type: "text", text: "go" }], authorAccountId: "a1" }, null),
  ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
];
const message = (
  seq: number,
  step: number,
  calls: { id: string; name: string; input: unknown }[],
) =>
  ev(seq, "assistant_message", {
    step,
    stopReason: "tool_use",
    content: [
      { type: "text", text: "Writing it." },
      ...calls.map((c) => ({ type: "tool_call", ...c })),
    ],
  });

const builtin = (
  key: string,
  kind: ToolInfo["kind"],
  keyArgs: string[],
  inputView: ToolInfo["inputView"],
): [string, ToolInfo] => [
  key,
  {
    key,
    title: null,
    kind,
    icon: { kind: "name", name: "extension" },
    sandbox: true,
    keyArgs,
    inputView,
    tool: null,
    source: { kind: "builtin" },
  },
];
const INFO = new Map<string, ToolInfo>([
  builtin("Write", "edit", ["file_path"], {
    kind: "file_write",
    path: "file_path",
    content: "content",
  }),
  builtin("Edit", "edit", ["file_path"], {
    kind: "file_edit",
    path: "file_path",
    old: "old_string",
    new: "new_string",
  }),
  builtin("Bash", "command", ["command"], {
    kind: "command",
    command: "command",
    description: "description",
  }),
  builtin("Agent", "task", ["description"], { kind: "text", field: "prompt" }),
  [
    "mcp__acme__create_ticket",
    {
      key: "mcp__acme__create_ticket",
      title: null,
      kind: "connector",
      icon: { kind: "name", name: "connector" },
      sandbox: false,
      keyArgs: ["title"],
      inputView: null,
      tool: "create_ticket",
      source: { kind: "connector", id: "k1", name: "Acme" },
    },
  ],
]);

const draft = (tools: DraftTool[], text = "", step = 1): TimelineDraft => ({
  runId: "r1",
  step,
  text,
  thinking: "",
  tools,
});
const timeline = (events: ConversationEvent[], drafts: TimelineDraft[]) =>
  buildTimeline(events, drafts, INFO, "zh");
const groups = (entries: TimelineEntry[]) =>
  entries.filter((e): e is Extract<TimelineEntry, { kind: "tools" }> => e.kind === "tools");
const rowsOf = (entries: TimelineEntry[]): TimelineTool[] => groups(entries).flatMap((g) => g.rows);
/** A partial JSON input as the model writes it: `json` cut after `chars` characters. */
const head = (value: unknown, cut: number) => JSON.stringify(value).slice(0, cut);
const writeInput = { file_path: "src/a.ts", content: "line one\nline two\nline th" };
const writeText = JSON.stringify(writeInput);

describe("streaming tool rows", () => {
  it("a draft Write becomes a streaming row with its path", () => {
    const [tool] = rowsOf(
      timeline(asked, [draft([{ id: "c1", name: "Write", input: writeText.slice(0, -2) }])]),
    );
    expect(tool?.callId).toBe("c1");
    expect(tool?.row).toMatchObject({
      id: "r1\u0000c1",
      kind: "edit",
      name: "Write",
      status: "streaming",
      keyArg: "src/a.ts",
      progress: { lines: 3, bytes: writeText.length - 2 },
      detail: {
        live: { preview: true },
        diff: {
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: [
                { kind: "ctx", text: "line one" },
                { kind: "ctx", text: "line two" },
                { kind: "ctx", text: "line th" },
              ],
            },
          ],
        },
      },
    });
    // before the content arrives: the path alone, no block yet
    const [early] = rowsOf(
      timeline(asked, [draft([{ id: "c1", name: "Write", input: head(writeInput, 24) }])]),
    );
    expect(early?.row.keyArg).toBe("src/a.ts");
    expect(early?.row.detail).toBeUndefined();
  });

  it("a content-first Write shows no key argument until its path parsed (B1)", () => {
    const input = '{"content":"line one\nline two","file_path":"src/b.ts"';
    const at = (cut: number) =>
      rowsOf(timeline(asked, [draft([{ id: "c1", name: "Write", input: input.slice(0, cut) }])]))[0]
        ?.row;
    const early = at('{"content":"line one\nline two"'.length + 5);
    expect(early?.keyArg).toBeUndefined();
    expect(at(input.length)?.keyArg).toBe("src/b.ts");
    // in a process block the head reads the same row: no content there either
    const entries = timeline(asked, [
      draft([{ id: "c1", name: "Write", input: '{"content":"secret body"' }]),
    ]);
    expect(JSON.stringify(entries)).not.toContain('"keyArg":"secret body"');
    // a tool without declared key arguments or a view keeps the first string field
    const [generic] = rowsOf(
      timeline(asked, [
        draft([{ id: "c2", name: "mcp__acme__create_ticket", input: '{"body":"b","title":"T"' }]),
      ]),
    );
    expect(generic?.row.keyArg).toBe("T");
  });

  it("with a base the row carries a live diff and +a −b of the aligned part", () => {
    const base = "# Title\nold line\n\nkeep\nmore\nrest\n";
    const content = "# Title\nnew line\n\nkeep\nadd";
    const input = JSON.stringify({ file_path: "a.md", content }).slice(0, -2);
    const [tool] = rowsOf(
      timeline(asked, [
        draft([{ id: "c1", name: "Write", input, base: { text: base, sha256: "s" } }]),
      ]),
    );
    const want = liveWriteDiff(base, content);
    expect(want.added).toBeGreaterThan(0);
    expect(want.removed).toBe(1);
    expect(tool?.row).toMatchObject({
      status: "streaming",
      added: want.added,
      removed: want.removed,
      detail: { diff: want.diff, live: { pending: want.pending } },
    });
    expect(tool?.row.detail?.live?.preview).toBeUndefined();
  });

  describe("a guessed base (Write content-first spec §4.5)", () => {
    const base = "# Title\nold line\n\nkeep\nmore\nrest\n";
    const content = "# Title\nnew line\n\nkeep\nadd";
    const guessed = { text: base, sha256: "s", guess: { path: "/w/src/g.md" } };
    const contentFirst = `{"content":${JSON.stringify(content)}`;
    const rowFor = (input: string, b: DraftTool["base"]) =>
      rowsOf(
        timeline(asked, [
          draft([{ id: "g1", name: "Write", input, ...(b !== undefined ? { base: b } : {}) }]),
        ]),
      )[0]?.row;

    it("draws the live diff, no +a −b, and the guessed path marked as a guess", () => {
      const row = rowFor(contentFirst, guessed);
      const want = liveWriteDiff(base, content);
      expect(row?.detail).toEqual({ diff: want.diff, live: { pending: want.pending } });
      expect(row?.added).toBeUndefined();
      expect(row?.removed).toBeUndefined();
      expect(row?.keyArg).toBe("/w/src/g.md");
      expect(row?.keyArgGuess).toBe(true);
      // the real path still being written: the guess stays
      const open = rowFor(`${contentFirst},"file_path":"src/g`, guessed);
      expect(open).toMatchObject({ keyArg: "/w/src/g.md", keyArgGuess: true });
    });

    it("once the real path closed, the real path shows without the guess mark", () => {
      const row = rowFor(`${contentFirst},"file_path":"src/g.md"`, guessed);
      expect(row?.keyArg).toBe("src/g.md");
      expect(row?.keyArgGuess).toBeUndefined();
      expect(row?.added).toBeUndefined();
    });

    it("confirmed: the ordinary row against a base", () => {
      const row = rowFor(`${contentFirst},"file_path":"src/g.md"`, {
        ...guessed,
        verdict: "confirmed",
      });
      const want = liveWriteDiff(base, content);
      expect(row).toMatchObject({ keyArg: "src/g.md", added: want.added, removed: want.removed });
      expect(row?.keyArgGuess).toBeUndefined();
    });

    it("rejected: the writing form, as without a base", () => {
      const row = rowFor(`${contentFirst},"file_path":"src/other.md"`, {
        ...guessed,
        verdict: "rejected",
      });
      expect(row?.detail?.live).toEqual({ preview: true });
      expect(row?.added).toBeUndefined();
      expect(row?.keyArg).toBe("src/other.md");
      expect(row?.keyArgGuess).toBeUndefined();
    });
  });

  it("the logged call replaces the streaming row with the same id", () => {
    const streaming = timeline(asked, [
      draft([{ id: "c1", name: "Write", input: writeText.slice(0, 30) }], "Writing it."),
    ]);
    const logged = timeline(
      [...asked, message(3, 1, [{ id: "c1", name: "Write", input: writeInput }])],
      [],
    );
    const [before] = groups(streaming);
    const [after] = groups(logged);
    expect(before?.rows[0]?.row.status).toBe("streaming");
    expect(after?.rows[0]?.row.status).not.toBe("streaming");
    // the same row id and the same group key: React keeps the row (and whether it is open)
    expect(after?.rows[0]?.row.id).toBe(before?.rows[0]?.row.id);
    expect(after?.key).toBe(before?.key);
  });

  it("a streamed id the message lacks disappears", () => {
    const delta = (d: Partial<StreamDelta>): StreamDelta =>
      ({ runId: "r1", step: 1, ...d }) as StreamDelta;
    let s = reduceChat(initialChatState, { kind: "events", events: asked });
    s = reduceChat(s, {
      kind: "deltas",
      deltas: [
        delta({ delta: "tool_start", callId: "c1", name: "Bash" }),
        delta({ delta: "tool_input", callId: "c1", offset: 0, text: '{"command":"ls"}' }),
        delta({ delta: "tool_start", callId: "c2", name: "Bash" }),
        delta({ delta: "tool_input", callId: "c2", offset: 0, text: '{"command":"pw' }),
      ],
    });
    expect(rowsOf(timeline(s.events, s.drafts)).map((r) => r.callId)).toEqual(["c1", "c2"]);
    s = reduceChat(s, {
      kind: "events",
      events: [message(3, 1, [{ id: "c1", name: "Bash", input: { command: "ls" } }])],
    });
    const rows = rowsOf(timeline(s.events, s.drafts));
    expect(rows.map((r) => r.callId)).toEqual(["c1"]);
    expect(rows[0]?.row.status).toBe("pending");
  });

  it("Bash shows the description only once it is complete", () => {
    const input = { command: "ls -la /tmp", description: "List the temp files" };
    const at = (cut: number) =>
      rowsOf(timeline(asked, [draft([{ id: "c1", name: "Bash", input: head(input, cut) }])]))[0]
        ?.row;
    const growing = at('{"command":"ls -la /t'.length);
    expect(growing).toMatchObject({ kind: "command", keyArg: "ls -la /t", status: "streaming" });
    expect(growing?.detail?.command).toBe("ls -la /t");
    // the description's string is still open: the command stays
    const half = at(JSON.stringify(input).length - 5);
    expect(half?.description).toBeUndefined();
    expect(half?.keyArg).toBe("ls -la /tmp");
    // closed (the object itself may still be open)
    const done = at(JSON.stringify(input).length - 1);
    expect(done?.description).toBe("List the temp files");
    expect(done?.progress).toEqual({ bytes: JSON.stringify(input).length - 1 });
  });

  it("a truncated input shows its retained head and that head's size (no total on the wire)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
    const truncatedHead = JSON.stringify({ file_path: "big.csv", content: lines }).slice(0, 200);
    const [tool] = rowsOf(
      timeline(asked, [
        draft([{ id: "c1", name: "Write", input: truncatedHead, inputTruncated: true }]),
      ]),
    );
    expect(tool?.row.status).toBe("streaming");
    expect(tool?.row.keyArg).toBe("big.csv");
    expect(tool?.row.progress?.bytes).toBe(200);
    const shown = tool?.row.detail?.diff?.hunks[0]?.lines ?? [];
    expect(shown[0]).toEqual({ kind: "ctx", text: "row 0" });
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.length).toBeLessThan(50);
  });

  it("consecutive streaming calls form one group after the draft's prose", () => {
    const out = timeline(asked, [
      draft(
        [
          { id: "c1", name: "Bash", input: '{"command":"ls"}' },
          { id: "c2", name: "Write", input: '{"file_path":"b.txt","content":"x' },
        ],
        "Let me look.",
      ),
    ]);
    expect(out.slice(-2).map((e) => e.kind)).toEqual(["prose", "tools"]);
    // the prose is written once a call starts: no cursor
    expect(out.at(-2)).toMatchObject({ kind: "prose", text: "Let me look.", streaming: false });
    expect(groups(out)).toHaveLength(1);
    expect(groups(out)[0]?.rows.map((r) => r.callId)).toEqual(["c1", "c2"]);
  });

  it("a draft without prose joins the log's last group, as the logged step will", () => {
    const step1 = [...asked, message(3, 0, [{ id: "c0", name: "Bash", input: { command: "ls" } }])];
    const withResult = [
      ...step1,
      ev(4, "tool_result", {
        step: 0,
        callId: "c0",
        toolKey: "Bash",
        content: "ok",
        isError: false,
      }),
    ];
    const out = timeline(withResult, [
      draft([{ id: "c1", name: "Bash", input: '{"command":"pwd' }]),
    ]);
    const gs = groups(out);
    expect(gs).toHaveLength(1);
    expect(gs[0]?.rows.map((r) => [r.callId, r.row.status])).toEqual([
      ["c0", "done"],
      ["c1", "streaming"],
    ]);
    const logged = timeline(
      [
        ...withResult,
        ev(5, "assistant_message", {
          step: 1,
          stopReason: "tool_use",
          content: [{ type: "tool_call", id: "c1", name: "Bash", input: { command: "pwd" } }],
        }),
      ],
      [],
    );
    expect(groups(logged)[0]?.key).toBe(gs[0]?.key);
  });

  it("a prose-less draft joins the log's last group past its files, keeping the key once logged", () => {
    const withFile = [
      ...asked,
      message(3, 0, [{ id: "c0", name: "Bash", input: { command: "make" } }]),
      ev(4, "tool_result", {
        step: 0,
        callId: "c0",
        toolKey: "Bash",
        content: "ok",
        isError: false,
      }),
      ev(5, "artifact_created", {
        artifactId: "f1",
        name: "out.csv",
        contentType: "text/csv",
        size: 10,
        callId: "c0",
        sourcePath: "out.csv",
      }),
    ];
    const streaming = timeline(withFile, [
      draft([{ id: "c1", name: "Bash", input: '{"command":"wc' }]),
    ]);
    expect(streaming.slice(-2).map((e) => e.kind)).toEqual(["tools", "files"]);
    const logged = timeline(
      [
        ...withFile,
        ev(6, "assistant_message", {
          step: 1,
          stopReason: "tool_use",
          content: [{ type: "tool_call", id: "c1", name: "Bash", input: { command: "wc" } }],
        }),
      ],
      [],
    );
    expect(groups(streaming)).toHaveLength(1);
    expect(groups(logged)).toHaveLength(1);
    expect(groups(logged)[0]?.key).toBe(groups(streaming)[0]?.key);
    expect(groups(streaming)[0]?.rows.map((r) => r.callId)).toEqual(["c0", "c1"]);
    expect(groups(logged)[0]?.rows.map((r) => r.callId)).toEqual(["c0", "c1"]);
  });

  it("in a process block a streamed step stands where the logged one lands (past its cards)", () => {
    // conversation process blocks: the block, its tools step and the rail step of the call keep
    // their keys from streaming to logged; a process card and a pinned card of the earlier call
    // follow its group and are walked past, as the logged step joins the same group
    const withCards = [
      ...asked,
      ev(3, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
      message(4, 0, [{ id: "c0", name: "Bash", input: { command: "make" } }]),
      ev(5, "tool_result", {
        step: 0,
        callId: "c0",
        toolKey: "Bash",
        content: "ok",
        isError: false,
        card: { plugin: "charts", view: "chart", placement: "process" },
      }),
      ev(6, "tool_result", {
        step: 0,
        callId: "c0",
        toolKey: "Bash",
        content: "ok",
        isError: false,
        card: { plugin: "todo", view: "tasks", placement: "pinned" },
      }),
    ];
    const blockOf = (entries: TimelineEntry[]): ProcessEntry => {
      const b = groupProcess(entries).find((e): e is ProcessEntry => e.kind === "process");
      if (b === undefined) throw new Error("no process block");
      return b;
    };
    /** Each tools step's key with its calls split by model step, as the rail draws them. */
    const rail = (b: ProcessEntry) =>
      b.steps.flatMap((x) =>
        x.kind === "tools"
          ? [[x.key, x.rows.map((r) => `${r.callId}@${r.step?.runId}:${r.step?.step}`)]]
          : [[x.kind]],
      );
    const streaming = blockOf(
      timeline(withCards, [draft([{ id: "c1", name: "Bash", input: '{"command":"wc' }])]),
    );
    const logged = blockOf(
      timeline(
        [
          ...withCards,
          ev(7, "assistant_message", {
            step: 1,
            stopReason: "tool_use",
            content: [{ type: "tool_call", id: "c1", name: "Bash", input: { command: "wc" } }],
          }),
        ],
        [],
      ),
    );
    expect(rail(streaming)).toEqual([
      ["narration"],
      [expect.any(String), ["c0@r1:0", "c1@r1:1"]],
      ["card"],
    ]);
    expect(rail(logged)).toEqual(rail(streaming));
    expect(logged.key).toBe(streaming.key);
    expect(logged.pinned.map((c) => c.plugin)).toEqual(["todo"]);
    expect(streaming.pinned.map((c) => c.plugin)).toEqual(["todo"]);
    const row = (b: ProcessEntry) =>
      b.steps.flatMap((x) => (x.kind === "tools" ? x.rows : [])).find((r) => r.callId === "c1");
    expect(row(streaming)?.row.status).toBe("streaming");
    expect(row(logged)?.row.id).toBe(row(streaming)?.row.id);
  });

  it("a file placed on its own ends the group: the streaming call opens a new one", () => {
    const loose = [
      ...asked,
      message(3, 0, [{ id: "c0", name: "Bash", input: { command: "make" } }]),
      ev(4, "artifact_created", {
        artifactId: "f1",
        name: "x.csv",
        contentType: "text/csv",
        size: 1,
        callId: "other",
        sourcePath: "x.csv",
      }),
    ];
    const out = timeline(loose, [draft([{ id: "c1", name: "Bash", input: '{"command":"ls' }])]);
    expect(groups(out).map((g) => g.rows.map((r) => r.callId))).toEqual([["c0"], ["c1"]]);
  });

  it("Edit streams old as removed and new as added, numbers pending", () => {
    const input = '{"file_path":"a.py","old_string":"a = 1\\nb = 2","new_string":"a = 10\\nb';
    const [tool] = rowsOf(timeline(asked, [draft([{ id: "c1", name: "Edit", input }])]));
    expect(tool?.row.detail?.live).toEqual({ gutter: "pending" });
    expect(tool?.row.detail?.diff?.hunks[0]?.lines).toEqual([
      { kind: "del", text: "a = 1" },
      { kind: "del", text: "b = 2" },
      { kind: "add", text: "a = 10" },
      { kind: "add", text: "b" },
    ]);
    expect(tool?.row.progress?.lines).toBe(2);
  });

  it("an Edit still writing old_string shows its size only, lines count from new_string (B4)", () => {
    const input = '{"file_path":"a.py","old_string":"a = 1\nb = 2';
    const [tool] = rowsOf(timeline(asked, [draft([{ id: "c1", name: "Edit", input }])]));
    expect(tool?.row.progress).toEqual({ bytes: input.length });
    const next = `${input}","new_string":"x`;
    const [started] = rowsOf(timeline(asked, [draft([{ id: "c1", name: "Edit", input: next }])]));
    expect(started?.row.progress?.lines).toBe(1);
  });

  it("an Agent prompt streams as bounded live output", () => {
    const prompt = Array.from({ length: LIVE_MAX_LINES + 10 }, (_, i) =>
      i === LIVE_MAX_LINES + 9 ? "x".repeat(LIVE_LINE_MAX_CHARS + 50) : `line ${i}`,
    ).join("\n");
    const input = JSON.stringify({ description: "Check the totals", prompt }).slice(0, -2);
    const [tool] = rowsOf(timeline(asked, [draft([{ id: "c1", name: "Agent", input }])]));
    expect(tool?.row.keyArg).toBe("Check the totals");
    const out = tool?.row.detail?.output ?? "";
    const lines = out.split("\n");
    expect(lines).toHaveLength(LIVE_MAX_LINES);
    expect(lines[0]).toBe("line 10");
    expect(lines.at(-1)).toHaveLength(LIVE_LINE_MAX_CHARS);
    expect(tool?.row.progress?.lines).toBe(LIVE_MAX_LINES + 10);
  });

  it("streaming text keeps at most 256 KB of the tail", () => {
    const long = Array.from({ length: 500 }, () => "y".repeat(1000)).join("\n");
    const out = liveTextTail(long);
    expect(out.length).toBeLessThanOrEqual(256 * 1024);
    expect(long.endsWith(out)).toBe(true);
  });

  it("a tool without an input view streams its key argument and the parsed input", () => {
    const input = '{"title":"Mismatch","body":"Payee r';
    const [tool] = rowsOf(
      timeline(asked, [draft([{ id: "c1", name: "mcp__acme__create_ticket", input }])]),
    );
    expect(tool?.row).toMatchObject({
      kind: "connector",
      name: "Acme",
      tool: "create_ticket",
      keyArg: "Mismatch",
      progress: { bytes: utf8Bytes(input), generic: true },
      detail: {
        input: [
          ["title", "Mismatch"],
          ["body", "Payee r"],
        ],
      },
    });
  });

  it("an unchanged call is not parsed again: the same row object comes back", () => {
    const tools: DraftTool[] = [{ id: "c1", name: "Write", input: writeText.slice(0, -2) }];
    const base = buildEventTimeline(asked, INFO, "zh");
    const a = rowsOf(withDrafts(base, [draft(tools)]))[0];
    const b = rowsOf(withDrafts(base, [draft(tools)]))[0];
    expect(b).toBe(a);
    // new tool info (e.g. it arrived) builds it again
    const other = buildEventTimeline(asked, new Map(), "zh");
    expect(rowsOf(withDrafts(other, [draft(tools)]))[0]).not.toBe(a);
  });

  it("a streaming call hides the working line and asks for its tool's info", () => {
    const drafts = [
      draft([{ id: "c1", name: "Write", input: "" }]),
      draft(
        [
          { id: "c2", name: "Bash", input: "" },
          { id: "c3", name: "Write", input: "" },
        ],
        "",
        2,
      ),
    ];
    expect(
      workingLineVisible(asked, drafts, {
        waiting: false,
        pending: 0,
        sentHere: new Map(),
        now: t,
      }),
    ).toBe(false);
    expect(streamedToolKeys(drafts)).toEqual(["Bash", "Write"]);
    expect(streamedToolKeys([])).toEqual([]);
  });
});

describe("a logged Write / Edit keeps its live diff until the result (D8, R13)", () => {
  const started = (seq: number, callId: string) =>
    ev(seq, "tool_call_started", { step: 1, callId, toolKey: "Write", specHash: "h" });
  const result = (seq: number, callId: string, extra: Record<string, unknown> = {}) =>
    ev(seq, "tool_result", {
      step: 1,
      callId,
      toolKey: "Write",
      content: "ok",
      isError: false,
      ...extra,
    });

  it("streaming, then pending and running show the last live diff; the result's diff replaces it", () => {
    const base = "# Title\nold line\nkeep\nmore\n";
    const content = "# Title\nnew line\nkeep\nmore\n";
    const full = { file_path: "a.md", content };
    const [streaming] = rowsOf(
      timeline(asked, [
        draft([
          {
            id: "lw1",
            name: "Write",
            input: JSON.stringify(full).slice(0, -2),
            base: { text: base, sha256: "s1" },
          },
        ]),
      ]),
    );
    const liveDiff = streaming?.row.detail?.diff;
    expect(liveDiff?.hunks.length).toBeGreaterThan(0);
    const logged = [...asked, message(3, 1, [{ id: "lw1", name: "Write", input: full }])];
    const [pending] = rowsOf(timeline(logged, []));
    expect(pending?.row.status).toBe("pending");
    // the complete input gives the same diff as the (complete) last frame
    expect(pending?.row.detail?.diff).toEqual(liveDiff);
    expect(pending?.row.detail?.live).toEqual(streaming?.row.detail?.live);
    expect(streaming?.row.removed).toBe(1);
    expect(pending?.row.added).toBe(streaming?.row.added);
    expect(pending?.row.removed).toBe(1);
    const [running] = rowsOf(timeline([...logged, started(4, "lw1")], []));
    expect(running?.row.status).toBe("running");
    expect(running?.row.detail?.diff).toEqual(liveDiff);
    const hunks = [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: "ctx", text: "# Title" },
          { kind: "del", text: "old line" },
          { kind: "add", text: "new line" },
          { kind: "ctx", text: "keep" },
        ],
      },
    ];
    const view = {
      kind: "edit",
      path: "a.md",
      created: false,
      added: 1,
      removed: 1,
      hunks,
      truncated: false,
    };
    const [done] = rowsOf(timeline([...logged, started(4, "lw1"), result(5, "lw1", { view })], []));
    expect(done?.row.status).toBe("done");
    expect(done?.row.detail?.diff).toEqual({ hunks, truncated: false });
    expect(done?.row.detail?.live).toBeUndefined();
  });

  it("a last frame that lags the final input: the logged row diffs the whole input", () => {
    const base = "a\nb\nc\nd\ne\n";
    const content = "a\nB\nc\nd\nE\nf\n";
    const full = { file_path: "lag.md", content };
    // the last frame streamed stops after "c": "d", "E", "f" never arrived as deltas
    const lagging = JSON.stringify(full).slice(0, JSON.stringify(full).indexOf("c\\n") + 3);
    const [streaming] = rowsOf(
      timeline(asked, [
        draft([{ id: "lw5", name: "Write", input: lagging, base: { text: base, sha256: "s5" } }]),
      ]),
    );
    const want = liveWriteDiff(base, content);
    expect(streaming?.row.detail?.diff).not.toEqual(want.diff);
    const logged = [...asked, message(3, 1, [{ id: "lw5", name: "Write", input: full }])];
    const [pending] = rowsOf(timeline(logged, []));
    expect(pending?.row.detail?.diff).toEqual(want.diff);
    expect(pending?.row.detail?.live).toEqual({ pending: want.pending });
    expect(pending?.row).toMatchObject({ added: want.added, removed: want.removed });
    const shown = pending?.row.detail?.diff?.hunks.flatMap((h) => h.lines.map((l) => l.text));
    expect(shown).toContain("f");
  });

  it("a call with a result, or of an ended run, computes no live diff", () => {
    const input = { file_path: "h.md", content: "x\ny\n" };
    const history = [
      ...asked,
      message(3, 1, [
        { id: "lw6", name: "Write", input },
        { id: "lw7", name: "Edit", input: { file_path: "h.md", old_string: "x", new_string: "z" } },
      ]),
      result(4, "lw6"),
      ev(5, "run_aborted", {}),
    ];
    const before = loggedLiveStats.runs;
    const rows = rowsOf(timeline(history, []));
    expect(loggedLiveStats.runs).toBe(before);
    expect(rows.map((r) => r.row.detail?.diff)).toEqual([undefined, undefined]);
    // the same calls while the run goes on: the open Edit computes one, the done Write none
    rowsOf(timeline(history.slice(0, -1), []));
    expect(loggedLiveStats.runs).toBe(before + 1);
  });

  it("the logged row keeps only an exact or a confirmed base (a guess is not remembered)", () => {
    const base = "a\nb\n";
    const full = { file_path: "g.md", content: "a\nB\n" };
    const streamed = (id: string, verdict?: "confirmed" | "rejected") =>
      timeline(asked, [
        draft([
          {
            id,
            name: "Write",
            input: JSON.stringify(full).slice(0, -2),
            base: {
              text: base,
              sha256: "sg",
              guess: { path: "/w/g.md" },
              ...(verdict !== undefined ? { verdict } : {}),
            },
          },
        ]),
      ]);
    const loggedRow = (id: string) =>
      rowsOf(timeline([...asked, message(3, 1, [{ id, name: "Write", input: full }])], []))[0]?.row;
    for (const [id, verdict] of [
      ["gw1", undefined],
      ["gw2", "rejected"],
    ] as const) {
      streamed(id, verdict);
      expect(loggedRow(id)?.detail?.live).toEqual({ preview: true });
    }
    streamed("gw3", "confirmed");
    const want = liveWriteDiff(base, full.content);
    expect(loggedRow("gw3")?.detail?.live).toEqual({ pending: want.pending });
    expect(loggedRow("gw3")).toMatchObject({ added: want.added, removed: want.removed });
  });

  it("without a remembered base the logged input gives the writing form", () => {
    const logged = [
      ...asked,
      message(3, 1, [
        { id: "lw2", name: "Write", input: { file_path: "n.md", content: "a\nb\n" } },
      ]),
    ];
    const [pending] = rowsOf(timeline(logged, []));
    expect(pending?.row.detail?.live).toEqual({ preview: true });
    expect(pending?.row.detail?.diff?.hunks[0]?.lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
    ]);
  });

  it("a result without a diff, or a cancel, drops the live diff and its counts", () => {
    const base = "x\ny\n";
    const full = { file_path: "b.md", content: "x\nz\n" };
    rowsOf(
      timeline(asked, [
        draft([
          {
            id: "lw3",
            name: "Write",
            input: JSON.stringify(full).slice(0, -2),
            base: { text: base, sha256: "s3" },
          },
        ]),
      ]),
    );
    const logged = [...asked, message(3, 1, [{ id: "lw3", name: "Write", input: full }])];
    const [failed] = rowsOf(
      timeline([...logged, result(4, "lw3", { isError: true, content: "denied" })], []),
    );
    expect(failed?.row.detail?.diff).toBeUndefined();
    expect(failed?.row.detail?.live).toBeUndefined();
    expect(failed?.row.added).toBeUndefined();
    expect(failed?.row.detail?.input).toContainEqual(["file_path", "b.md"]);
    const [cancelled] = rowsOf(timeline([...logged, ev(4, "run_aborted", {})], []));
    expect(cancelled?.row.status).toBe("cancelled");
    expect(cancelled?.row.detail?.diff).toBeUndefined();
  });

  it("bounds a logged input value", () => {
    const big = "v".repeat(INPUT_VALUE_MAX_CHARS + 100);
    const logged = [
      ...asked,
      message(3, 1, [
        { id: "lw4", name: "mcp__acme__create_ticket", input: { title: "t", body: big } },
      ]),
    ];
    const [row] = rowsOf(timeline(logged, []));
    const body = row?.row.detail?.input?.find(([k]) => k === "body")?.[1];
    expect(body).toBe(`${"v".repeat(INPUT_VALUE_MAX_CHARS)}…`);
  });
});

describe("a streaming command is bounded", () => {
  it("keeps the key argument's head and the command's tail", () => {
    const heredoc = `cat > big.txt <<'EOF'\n${Array.from({ length: 4000 }, (_, i) => `row ${i} ${"z".repeat(80)}`).join("\n")}`;
    const input = JSON.stringify({ command: heredoc }).slice(0, -2);
    const [tool] = rowsOf(timeline(asked, [draft([{ id: "bc1", name: "Bash", input }])]));
    const keyArg = tool?.row.keyArg ?? "";
    expect(keyArg.length).toBe(COMMAND_KEY_ARG_MAX_CHARS);
    expect(keyArg.startsWith("cat > big.txt <<'EOF'\n")).toBe(true);
    const command = tool?.row.detail?.command ?? "";
    expect(command.length).toBeLessThanOrEqual(LIVE_TEXT_MAX_CHARS);
    expect(command.split("\n")).toHaveLength(LIVE_MAX_LINES);
    expect(heredoc.endsWith(command)).toBe(true);
  });
});

describe("live line cut", () => {
  it("a surrogate pair at the cut never leaves a lone surrogate", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const at of [LIVE_LINE_MAX_CHARS - 1, LIVE_LINE_MAX_CHARS]) {
      const line = `${"x".repeat(at)}😀${"y".repeat(20)}`;
      const shown = liveTextTail(`${line}\nnext`).split("\n")[0] ?? "";
      expect(shown.length).toBeLessThanOrEqual(LIVE_LINE_MAX_CHARS);
      expect(lone.test(shown)).toBe(false);
      const diff = liveWriteDiff("", `${line}\n`);
      const text = diff.diff.hunks[0]?.lines[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(LIVE_LINE_MAX_CHARS);
      expect(lone.test(text)).toBe(false);
    }
  });
});
