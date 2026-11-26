import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import { liveWriteDiff } from "../src/lib/live-diff";
import type { DraftTool } from "../src/lib/run-drafts";
import { initialChatState, reduceChat, type StreamDelta } from "../src/lib/stream";
import {
  LIVE_LINE_MAX_CHARS,
  LIVE_MAX_LINES,
  liveTextTail,
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

  it("inputTruncated shows the head and the size", () => {
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
    expect(streamedToolKeys(drafts)).toBe("Bash\nWrite");
    expect(streamedToolKeys([])).toBe("");
  });
});
