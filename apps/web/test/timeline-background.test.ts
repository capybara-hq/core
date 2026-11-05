import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { hasBackgroundTasks } from "../src/lib/query/conversation";
import { buildTimeline, type TimelineEntry } from "../src/lib/timeline";

/**
 * Background Bash in the timeline (background Bash spec §5): a background `Bash` row carries its
 * task (the thread labels it "In background" and links `#bg-<id>`), `TaskOutput` / `TaskStop`
 * rows name the task's description, and `background_task_finished` is a one-line notice.
 */

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
const call = (seq: number, id: string, name: string, input: unknown) =>
  ev(seq, "assistant_message", {
    step: 0,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id, name, input }],
  });
const result = (seq: number, callId: string, toolKey: string, content: string) =>
  ev(seq, "tool_result", { step: 0, callId, toolKey, content, isError: false });
const finished = (seq: number, extra: Record<string, unknown> = {}) =>
  ev(
    seq,
    "background_task_finished",
    {
      taskId: "bt_abc234",
      description: "Start the dev server",
      status: "failed",
      exitCode: 1,
      elapsedMs: 72_000,
      lastLines: "boom",
      outputPath: ".capybara/tasks/bt_abc234.out",
      reported: false,
      ...extra,
    },
    null,
  );

const LAUNCH: ConversationEvent[] = [
  ev(1, "user_message", { content: [{ type: "text", text: "go" }], authorAccountId: "a1" }, null),
  call(2, "k1", "Bash", {
    command: "pnpm dev",
    description: "Start the dev server",
    run_in_background: true,
  }),
  result(3, "k1", "Bash", 'Started background task bt_abc234 ("Start the dev server").'),
];

const build = (events: ConversationEvent[]) => buildTimeline(events, [], new Map(), "en");
const rows = (entries: TimelineEntry[]) =>
  entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));

describe("background Bash in the timeline", () => {
  it("a background Bash row carries its task id from the result", () => {
    const [row] = rows(build(LAUNCH));
    expect(row?.background).toEqual({ taskId: "bt_abc234" });
    expect(row?.row.description).toBe("Start the dev server");
  });

  it("a background Bash row before its result is still background, with no task yet", () => {
    const [row] = rows(build(LAUNCH.slice(0, 2)));
    expect(row?.background).toEqual({ taskId: null });
  });

  it("a foreground Bash row is no background row", () => {
    const [row] = rows(
      build([
        call(1, "k1", "Bash", { command: "ls", description: "List" }),
        result(2, "k1", "Bash", "a"),
      ]),
    );
    expect(row?.background).toBeUndefined();
  });

  it("TaskOutput and TaskStop rows name the task's description instead of its id", () => {
    const entries = build([
      ...LAUNCH,
      call(4, "k2", "TaskOutput", { task_id: "bt_abc234" }),
      result(5, "k2", "TaskOutput", "Task bt_abc234 is running."),
      call(6, "k3", "TaskStop", { task_id: "bt_abc234" }),
      call(7, "k4", "TaskOutput", { task_id: "bt_zzzzzz" }),
    ]);
    const [, out, stop, unknown] = rows(entries);
    expect(out?.row.keyArg).toBe("Start the dev server");
    expect(stop?.row.keyArg).toBe("Start the dev server");
    // a task the log never launched keeps its id
    expect(unknown?.row.keyArg).toBe("bt_zzzzzz");
  });

  it("background_task_finished is a notice entry that names the task", () => {
    const entries = build([...LAUNCH, finished(4)]);
    expect(entries.at(-1)).toMatchObject({
      kind: "background",
      key: "e4",
      taskId: "bt_abc234",
      description: "Start the dev server",
      status: "failed",
      exitCode: 1,
    });
  });

  it("the gate: a background call, a finish, or a sub-agent (whose own tasks nest under it)", () => {
    expect(hasBackgroundTasks(LAUNCH.slice(0, 1))).toBe(false);
    expect(hasBackgroundTasks([call(1, "k1", "Bash", { command: "ls" })])).toBe(false);
    expect(hasBackgroundTasks(LAUNCH.slice(0, 2))).toBe(true);
    expect(hasBackgroundTasks([finished(1)])).toBe(true);
    expect(hasBackgroundTasks([ev(1, "subagent_dispatched", { subagentId: "ch1" })])).toBe(true);
  });
});
