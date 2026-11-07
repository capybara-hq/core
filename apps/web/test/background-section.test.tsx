import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { ConversationEvent } from "../src/lib/conversations";
import { type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

/**
 * Background Bash on the conversation page (background Bash spec §5): the properties panel's
 * background section (the conversation's tasks, its sub-agents and their tasks nested under them),
 * stop, the task output panel (`#bg-<taskId>`, polled while the task runs), the background row
 * label and the finish notice in the thread.
 */

const params = { conversationId: "c1" };
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const PARENT = `${ORG}/conversations/c1`;
const TASKS = `${PARENT}/background-tasks`;
const TASK = "bt_abc234";

const launch = (): ConversationEvent[] => [
  userMsg(1, "go"),
  runStarted(2),
  ev(3, "assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "k1",
        name: "Bash",
        input: {
          command: "pnpm dev",
          description: "Start the dev server",
          run_in_background: true,
        },
      },
    ],
  }),
  ev(4, "tool_result", {
    callId: "k1",
    toolKey: "Bash",
    content: `Started background task ${TASK} ("Start the dev server").`,
    isError: false,
    step: 1,
  }),
];

const dispatch = (seq: number): ConversationEvent[] => [
  ev(seq, "assistant_message", {
    step: 2,
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "a1",
        name: "Agent",
        input: { description: "Check tests", prompt: "Do it", subagent_type: "general-purpose" },
      },
    ],
  }),
  ev(seq + 1, "subagent_dispatched", {
    step: 2,
    callId: "a1",
    subagentId: "ch2",
    childRunId: "run-ch2",
    agentType: "general-purpose",
    description: "Check tests",
    resumed: false,
    model: { provider: "model-fake", model: "fake-1" },
  }),
];

const finishedEvent = (seq: number) =>
  ev(
    seq,
    "background_task_finished",
    {
      taskId: TASK,
      description: "Start the dev server",
      status: "failed",
      exitCode: 1,
      elapsedMs: 72_000,
      lastLines: "port 3000 in use",
      outputPath: `.capybara/tasks/${TASK}.out`,
      reported: false,
    },
    null,
  );

const task = (extra: Record<string, unknown> = {}) => ({
  id: TASK,
  conversationId: "c1",
  subagentId: null,
  description: "Start the dev server",
  command: "pnpm dev",
  status: "running",
  exitCode: null,
  lostReason: null,
  startedAt: "2026-10-26T06:00:04.000Z",
  finishedAt: null,
  stopping: false,
  ...extra,
});

const childTask = task({
  id: "bt_child1",
  conversationId: "ch2",
  subagentId: "ch2",
  description: "Watch the tests",
  command: "pnpm test --watch",
});

/** The agent tree the page reads with sub-agents (AC3 fix round 1: the agents chip counts it). */
const treeOf = (id: string, children: { id: string; status: string }[]) => ({
  root: {
    id,
    description: "",
    agentType: null,
    status: "running",
    model: null,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    tokens: 0,
    toolCalls: 0,
    children: children.map((c) => ({
      ...c,
      description: c.id,
      agentType: "general-purpose",
      model: null,
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      tokens: 0,
      toolCalls: 0,
      children: [],
    })),
  },
});

const subagent = {
  id: "ch2",
  agentType: "general-purpose",
  description: "Check tests",
  status: "running",
  toolCalls: 2,
  startedAt: "2026-10-26T06:00:04.000Z",
  finishedAt: null,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  pendingApprovalIds: [],
  pendingQuestionIds: [],
};

/** The routes; `state.tasks` is what the list answers now (a test changes it). */
function api(
  state: { tasks: unknown[]; events?: ConversationEvent[] },
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
) {
  return stubApi({
    [`GET ${PARENT}`]: () => json(200, CONV("c1")),
    [`GET ${PARENT}/events`]: () => json(200, { events: state.events ?? launch() }),
    [`GET ${PARENT}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${PARENT}/tools`]: () => json(200, { tools: [] }),
    [`GET ${PARENT}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${PARENT}/environment`]: () => json(200, { environment: null }),
    [`GET ${PARENT}/subagents`]: () => json(200, { subagents: [subagent], next: null }),
    [`GET ${PARENT}/usage`]: () =>
      json(200, {
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    [`GET ${PARENT}/agent-tree`]: () => json(200, treeOf("c1", [{ id: "ch2", status: "running" }])),
    [`GET ${TASKS}`]: () => json(200, { tasks: state.tasks }),
    [`GET ${TASKS}/${TASK}/output`]: () =>
      json(200, { text: "ready in 412 ms", truncated: false, source: "live" }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    ...extra,
  });
}

const stream = () =>
  FakeEventSource.instances.find((s) => s.url.startsWith(`${PARENT}/stream`)) as FakeEventSource;

const backgroundSection = async () => {
  const props = await screen.findByRole("complementary", { name: "Properties" });
  return (await within(props).findByText(en.subagents.background)).closest(
    '[data-part="property-section"]',
  ) as HTMLElement;
};

const outputReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.startsWith(`${TASKS}/${TASK}/output`)).length;

beforeEach(() => {
  params.conversationId = "c1";
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  window.history.replaceState(null, "", "/");
});

describe("the background section", () => {
  it("lists the running task, the sub-agent and its own task nested under it", async () => {
    api({ tasks: [task(), childTask], events: [...launch(), ...dispatch(5)] });
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    const section = await backgroundSection();
    const rows = await vi.waitFor(() => {
      const r = [...section.querySelectorAll('[data-part="task-row"]')] as HTMLElement[];
      if (r.length < 3) throw new Error("rows not yet");
      return r;
    });
    expect(rows.map((r) => r.querySelector("button")?.textContent)).toEqual([
      "Start the dev server",
      "Check tests",
      "Watch the tests",
    ]);
    expect(rows.map((r) => r.getAttribute("data-nested"))).toEqual([null, null, "true"]);
  });

  it("stop POSTs the stop, shows stopping, then the final status after the changed frame", async () => {
    const state = { tasks: [task()] as unknown[] };
    const calls = api(state, {
      [`POST ${TASKS}/${TASK}/stop`]: () => json(200, { task: task({ stopping: true }) }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    const section = await backgroundSection();
    const user = userEvent.setup();
    await user.click(
      await within(section).findByRole("button", { name: "Stop Start the dev server" }),
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${TASKS}/${TASK}/stop`)).toBe(
        true,
      ),
    );
    expect(await within(section).findByRole("status")).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Stop Start the dev server" })).toBeNull();
    // the task finishes; the kernel says so with `changed: background`
    state.tasks = [
      task({ status: "stopped", finishedAt: "2026-10-26T06:01:00.000Z", exitCode: 143 }),
    ];
    act(() => stream().emit("changed", { what: "background" }));
    await vi.waitFor(() => expect(within(section).queryByRole("status")).toBeNull());
    expect(within(section).queryByText("Start the dev server")).toBeNull();
    expect(within(section).getByRole("button", { name: /1 completed/ })).toBeTruthy();
  });

  it("a changed frame during the first read reads the list again (the read may predate the task)", async () => {
    // the launch's tool call reaches the page, which reads the list at once; the kernel inserts the
    // task's row and announces `changed: background` while that first read is still on its way
    const first = held({ tasks: [] });
    let reads = 0;
    const calls = api(
      { tasks: [], events: launch().slice(0, 2) },
      {
        [`GET ${TASKS}`]: () => {
          reads += 1;
          return reads === 1 ? first.response : json(200, { tasks: [task()] });
        },
      },
    );
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    await screen.findByRole("complementary", { name: "Properties" });
    const [, , call] = launch();
    act(() => stream().emit("event", call));
    await vi.waitFor(() => expect(reads).toBe(1));
    act(() => stream().emit("changed", { what: "background" }));
    await act(async () => first.release());
    const section = await backgroundSection();
    expect(
      await within(section).findByRole("button", { name: "Stop Start the dev server" }),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && c.url === TASKS)).toHaveLength(2);
  });

  it("is not read before the log shows a background task", async () => {
    const calls = api({ tasks: [], events: [userMsg(1, "hi")] });
    window.history.replaceState(null, "", "/chat/c1#properties");
    const { calls: server } = await renderChatRoute();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    await within(props).findByText("Context");
    expect(within(props).queryByText(en.subagents.background)).toBeNull();
    expect([...server, ...calls].some((c) => c.url.startsWith(TASKS))).toBe(false);
  });

  it("with a background task in the log, the server reads it and the browser does not", async () => {
    const calls = api({ tasks: [task()] });
    const { calls: server } = await renderChatRoute();
    expect(server.some((c) => c.url === TASKS)).toBe(true);
    expect(calls.some((c) => c.url.startsWith(TASKS))).toBe(false);
  });
});

/** A response held until `release` (a stop in flight). */
function held(body: unknown) {
  let release = () => {};
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(json(200, body));
  });
  return { response, release: () => release() };
}

const stopPosts = (calls: Call[], id: string) =>
  calls.filter((c) => c.method === "POST" && c.url === `${TASKS}/${id}/stop`).length;

describe("stops in flight", () => {
  it("two concurrent stops keep both rows stopping", async () => {
    const second = task({ id: "bt_second", description: "Watch the build" });
    const a = held({ task: task({ stopping: true }) });
    const b = held({ task: { ...second, stopping: true } });
    const calls = api(
      { tasks: [task(), second] },
      {
        [`POST ${TASKS}/${TASK}/stop`]: () => a.response,
        [`POST ${TASKS}/bt_second/stop`]: () => b.response,
      },
    );
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    const section = await backgroundSection();
    const user = userEvent.setup();
    await user.click(
      await within(section).findByRole("button", { name: "Stop Start the dev server" }),
    );
    await user.click(within(section).getByRole("button", { name: "Stop Watch the build" }));
    await vi.waitFor(() => expect(within(section).getAllByRole("status")).toHaveLength(2));
    expect(within(section).queryByRole("button", { name: /^Stop / })).toBeNull();
    expect(stopPosts(calls, TASK)).toBe(1);
    expect(stopPosts(calls, "bt_second")).toBe(1);
    // the answers say `stopping` too: still both stopping once the requests settle
    a.release();
    b.release();
    await vi.waitFor(() => expect(within(section).getAllByRole("status")).toHaveLength(2));
  });
});

describe("the task output panel", () => {
  it("one click on the panel's stop removes the button and sends exactly one POST", async () => {
    const stop = held({ task: task({ stopping: true }) });
    const calls = api({ tasks: [task()] }, { [`POST ${TASKS}/${TASK}/stop`]: () => stop.response });
    window.history.replaceState(null, "", `/chat/c1#bg-${TASK}`);
    await renderChatRoute();
    const panel = await screen.findByRole("complementary", { name: "Start the dev server" });
    const button = await within(panel).findByRole("button", { name: "Stop Start the dev server" });
    await userEvent.setup().click(button);
    await vi.waitFor(() =>
      expect(within(panel).queryByRole("button", { name: "Stop Start the dev server" })).toBeNull(),
    );
    expect(within(panel).getByRole("status").textContent).toBe("Stopping…");
    expect(stopPosts(calls, TASK)).toBe(1);
    stop.release();
    // the kernel's answer (`stopping: true`) keeps it stopping
    await vi.waitFor(() => expect(stopPosts(calls, TASK)).toBe(1));
    expect(within(panel).queryByRole("button", { name: "Stop Start the dev server" })).toBeNull();
  });

  it("a task row opens #bg-<id>: description, command and output", async () => {
    api({ tasks: [task()] });
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    const section = await backgroundSection();
    await userEvent
      .setup()
      .click(await within(section).findByRole("button", { name: "Start the dev server" }));
    expect(window.location.hash).toBe(`#bg-${TASK}`);
    const panel = await screen.findByRole("complementary", { name: "Start the dev server" });
    expect(await within(panel).findByText("ready in 412 ms")).toBeTruthy();
    expect(panel.querySelector('[data-part="task-command"]')?.textContent).toBe("pnpm dev");
  });

  it("polls the output while the task runs and stops once it finished", async () => {
    const state = { tasks: [task()] as unknown[] };
    const calls = api(state);
    window.history.replaceState(null, "", `/chat/c1#bg-${TASK}`);
    await renderChatRoute();
    await screen.findByRole("complementary", { name: "Start the dev server" });
    await vi.waitFor(() => expect(outputReads(calls)).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });
    state.tasks = [task({ status: "completed", exitCode: 0, finishedAt: "2026-10-26T06:01:00Z" })];
    act(() => stream().emit("changed", { what: "background" }));
    const panel = await screen.findByRole("complementary", { name: "Start the dev server" });
    await within(panel).findByText("Done");
    const settled = outputReads(calls);
    await new Promise((r) => setTimeout(r, 2500));
    expect(outputReads(calls)).toBe(settled);
  }, 15_000);

  it("a 409 (sandbox suspended) shows the unavailable note and the finish event's last lines", async () => {
    api(
      {
        tasks: [task({ status: "failed", exitCode: 1, finishedAt: "2026-10-26T06:01:16Z" })],
        events: [...launch(), finishedEvent(5)],
      },
      {
        [`GET ${TASKS}/${TASK}/output`]: () =>
          json(409, {
            error: { code: "background_task.output_unavailable", message: "suspended" },
          }),
      },
    );
    window.history.replaceState(null, "", `/chat/c1#bg-${TASK}`);
    await renderChatRoute();
    const panel = await screen.findByRole("complementary", { name: "Start the dev server" });
    expect(await within(panel).findByText("Output unavailable (sandbox suspended)")).toBeTruthy();
    expect(within(panel).getByText("port 3000 in use")).toBeTruthy();
  });
});

describe("background tasks in the thread", () => {
  it("labels the background Bash row and links its task", async () => {
    api({ tasks: [task()] });
    await renderChatRoute();
    const tools = await vi.waitFor(() => {
      const e = document.querySelector('[data-entry="tools"]');
      if (e === null) throw new Error("no row yet");
      return e as HTMLElement;
    });
    expect(tools.textContent).toContain(en.background.inBackground);
    await userEvent.setup().click(
      within(tools).getByRole("button", {
        name: en.background.openTask.replace("{name}", "Start the dev server"),
      }),
    );
    expect(window.location.hash).toBe(`#bg-${TASK}`);
  });

  it("renders the finish notice, which opens the task", async () => {
    api({
      tasks: [task({ status: "failed", exitCode: 1, finishedAt: "2026-10-26T06:01:16Z" })],
      events: [...launch(), finishedEvent(5)],
    });
    await renderChatRoute();
    const notice = await vi.waitFor(() => {
      const e = document.querySelector('[data-entry="background"]');
      if (e === null) throw new Error("no notice yet");
      return e as HTMLElement;
    });
    expect(notice.textContent).toContain(
      en.background.notice
        .replace("{description}", "Start the dev server")
        .replace("{status}", en.background.status.failed)
        .replace("{code}", "1"),
    );
    await userEvent.setup().click(within(notice).getByRole("button", { name: en.background.open }));
    expect(window.location.hash).toBe(`#bg-${TASK}`);
  });
});
