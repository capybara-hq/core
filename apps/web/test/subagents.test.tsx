import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import type { ConversationEvent } from "../src/lib/conversations";
import { initialChatState, reduceChat } from "../src/lib/stream";
import { buildTimeline, type TimelineEntry } from "../src/lib/timeline";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  MODELS,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

/**
 * UI refresh B Task 21: sub-agents on the conversation page, wired to phase C's events and routes.
 * The parent's `agent` calls are one sub-agent group; a row opens the child read-only in the right
 * panel (`#subagent=`), with its task, its own thread, stop and its status bar; a child's approval
 * or question shows in the parent with the sub-agent's name; the properties panel lists background
 * tasks and the Context total with sub-agents. Ports phase C's interim tests (`?subagent=`
 * validation, stop, `subagent_waiting` lines, the Context total via `/usage`, progress seeds).
 */

const params = { conversationId: "c1" };
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => params }));

const ORG = "/api/v1/orgs/o1";
const PARENT = `${ORG}/conversations/c1`;
const CHILD = `${ORG}/conversations/ch2`;

const call = (id: string, description: string, type = "general-purpose") => ({
  type: "tool_call",
  id,
  name: "agent",
  input: { description, prompt: `Do ${description}`, subagent_type: type },
});

const dispatched = (seq: number, callId: string, child: string, description: string) =>
  ev(seq, "subagent_dispatched", {
    step: 1,
    callId,
    subagentId: child,
    childRunId: `run-${child}`,
    agentType: "general-purpose",
    description,
    resumed: false,
    model: { provider: "model-fake", model: "fake-1" },
  });

const finished = (seq: number, callId: string, child: string, status: string, calls: number) =>
  ev(seq, "subagent_finished", {
    subagentId: child,
    childRunId: `run-${child}`,
    callId,
    status,
    toolCalls: calls,
    durationMs: 41_000,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

const agentResult = (seq: number, callId: string, content: string, isError = false) =>
  ev(seq, "tool_result", { callId, toolKey: "agent", content, isError, step: 1 });

/** A parent that dispatched two sub-agents in one step; the first one is done. */
function parentEvents(): ConversationEvent[] {
  return [
    userMsg(1, "go"),
    runStarted(2),
    ev(3, "assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [call("k1", "Scan docs"), call("k2", "Check tests")],
    }),
    dispatched(4, "k1", "ch1", "Scan docs"),
    dispatched(5, "k2", "ch2", "Check tests"),
    finished(6, "k1", "ch1", "completed", 3),
    agentResult(7, "k1", "Docs are fine."),
  ];
}

const waiting = (seq: number, extra: Record<string, unknown>) =>
  ev(seq, "subagent_waiting", {
    subagentId: "ch2",
    childRunId: "run-ch2",
    toolKey: "sandbox_bash",
    expiresAt: "2026-10-26T08:00:00.000Z",
    ...extra,
  });

/** The child's log: started, its task, a command, its reply. */
function childEvents(running = false): ConversationEvent[] {
  const c = (seq: number, type: string, payload: unknown, runId: string | null = "run-ch2") =>
    ev(seq, type, payload, runId, "ch2");
  return [
    c(
      1,
      "subagent_started",
      {
        parent: { conversationId: "c1", runId: "r1", callId: "k2", step: 1 },
        agentType: "general-purpose",
        template: { source: "general" },
        definition: {
          name: "Echo agent › general-purpose",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "builtin", name: "sandbox_bash" }],
        },
        maxSteps: 20,
      },
      null,
    ),
    c(
      2,
      "user_message",
      {
        content: [{ type: "text", text: "Do Check tests" }],
        authorAccountId: "a1",
        dispatch: { parentConversationId: "c1", parentRunId: "r1", callId: "k2" },
      },
      null,
    ),
    c(3, "run_started", { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } }),
    c(4, "assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [
        {
          type: "tool_call",
          id: "x1",
          name: "sandbox_bash",
          input: { command: "pnpm test", description: "Run the tests" },
        },
      ],
    }),
    c(5, "tool_result", {
      callId: "x1",
      toolKey: "sandbox_bash",
      content: "ok",
      isError: false,
      step: 1,
    }),
    c(6, "assistant_message", {
      step: 2,
      stopReason: "end_turn",
      content: [{ type: "text", text: "All tests pass." }],
    }),
    ...(running ? [] : [c(7, "run_finished", {})]),
  ];
}

const view = (id: string, description: string, status: string, extra = {}) => ({
  id,
  agentType: "general-purpose",
  description,
  status,
  toolCalls: 2,
  startedAt: "2026-10-26T06:00:04.000Z",
  finishedAt: status === "running" || status === "waiting" ? null : "2026-10-26T06:00:45.000Z",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  pendingApprovalIds: [],
  pendingQuestionIds: [],
  ...extra,
});

function api(
  extra: Record<string, (c: Call) => Response> = {},
  opts: { parent?: ConversationEvent[]; child?: ConversationEvent[] } = {},
) {
  return stubApi({
    [`GET ${PARENT}`]: () => json(200, CONV("c1")),
    [`GET ${PARENT}/events`]: () => json(200, { events: opts.parent ?? parentEvents() }),
    [`GET ${PARENT}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${PARENT}/tools`]: () => json(200, { tools: [] }),
    [`GET ${PARENT}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${PARENT}/sandbox`]: () =>
      json(404, { error: { code: "sandbox.not_found", message: "x" } }),
    [`GET ${PARENT}/subagents`]: () =>
      json(200, {
        subagents: [view("ch2", "Check tests", "running"), view("ch1", "Scan docs", "completed")],
        next: null,
      }),
    [`GET ${PARENT}/usage`]: () =>
      json(200, {
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 34, cacheWriteTokens: 0 },
      }),
    [`GET ${CHILD}`]: () =>
      json(200, CONV("ch2", { parentConversationId: "c1", subagentType: "general-purpose" })),
    [`GET ${CHILD}/events`]: () => json(200, { events: opts.child ?? childEvents(true) }),
    [`GET ${CHILD}/tools`]: () => json(200, { tools: [] }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    ...extra,
  });
}

const fileOf = (id: string, name: string, createdAt: string) => ({
  id,
  name,
  contentType: "text/plain",
  size: 5,
  sourcePath: `/workspace/${name}`,
  version: 1,
  versions: [{ id, size: 5, createdAt }],
  callId: "c",
  createdAt,
  status: "available",
  previewable: "text",
});

const TASKS_SECTION = {
  plugin: "todo",
  id: "tasks-section",
  title: { zh: "待办", en: "Tasks" },
  place: "section",
  kind: "view",
  icon: "list-checks",
};

const sectionTitles = (props: HTMLElement) =>
  [...props.querySelectorAll('[data-part="property-title"]')].map((e) => e.textContent);

const renderChat = () => renderPage(<ChatPage />, { locale: "en" });
const group = () => document.querySelector('[data-entry="subagents"]') as HTMLElement | null;
const rowOf = (name: string) =>
  screen.findByRole("button", { name: `Open ${name} on the right` }, { timeout: 3000 });

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

describe("the timeline's sub-agent groups", () => {
  const build = (events: ConversationEvent[], live?: Parameters<typeof buildTimeline>[4]) =>
    buildTimeline(events, [], new Map(), "en", live);
  const groups = (entries: TimelineEntry[]) =>
    entries.filter(
      (e): e is Extract<TimelineEntry, { kind: "subagents" }> => e.kind === "subagents",
    );

  it("agent calls of a step are one group, not tool rows: one running, one done", () => {
    const entries = build(parentEvents());
    expect(entries.some((e) => e.kind === "tools")).toBe(false);
    const [g] = groups(entries);
    expect(g?.rows.map((r) => [r.row.id, r.row.status, r.row.toolCalls])).toEqual([
      ["ch1", "completed", 3],
      ["ch2", "running", 0],
    ]);
    expect(g?.rows[0]?.row).toMatchObject({
      agentType: "general-purpose",
      description: "Scan docs",
      durationMs: 41_000,
      summary: { steps: [], result: "Docs are fine." },
    });
  });

  it("a finish status maps to the row (step and budget caps fail, aborted stops)", () => {
    const status = (s: string) =>
      groups(build([...parentEvents(), finished(8, "k2", "ch2", s, 1)]))[0]?.rows[1]?.row.status;
    expect(status("max_steps")).toBe("failed");
    expect(status("budget")).toBe("failed");
    expect(status("aborted")).toBe("aborted");
    expect(status("completed")).toBe("completed");
  });

  it("a refused agent call (no dispatch) is a failed row with its reason", () => {
    const entries = build([
      userMsg(1, "go"),
      runStarted(2),
      ev(3, "assistant_message", {
        step: 1,
        stopReason: "tool_use",
        content: [call("k9", "Spy", "nope")],
      }),
      agentResult(4, "k9", 'Unknown subagent_type "nope".', true),
    ]);
    expect(groups(entries)[0]?.rows[0]?.row).toMatchObject({
      status: "failed",
      agentType: "nope",
      description: "Spy",
      summary: { steps: [], result: 'Unknown subagent_type "nope".' },
    });
  });

  it("live progress raises the calls; the list's status shows a waiting row", () => {
    const entries = build(parentEvents(), {
      progress: { ch2: { toolCalls: 5 } },
      views: new Map([
        ["ch2", { status: "waiting", pendingApprovalIds: ["ap1"], pendingQuestionIds: [] }],
      ]),
    });
    expect(groups(entries)[0]?.rows[1]?.row).toMatchObject({
      toolCalls: 5,
      status: "waiting",
      waiting: "approval",
    });
  });

  it("subagent_waiting puts the child's wait in the parent, named by the sub-agent", () => {
    const entries = build([...parentEvents(), waiting(8, { kind: "approval", approvalId: "ap1" })]);
    const w = entries.at(-1);
    expect(w).toMatchObject({
      kind: "subagent-wait",
      subagent: { id: "ch2", name: "Check tests" },
      wait: "approval",
      approvalId: "ap1",
      toolKey: "sandbox_bash",
    });
  });

  it("a child's task message (dispatch) is a task entry, not a user bubble", () => {
    const entries = build(childEvents());
    expect(entries[0]).toMatchObject({ kind: "task", text: "Do Check tests" });
    expect(entries.some((e) => e.kind === "user")).toBe(false);
  });
});

describe("sub-agents on the conversation page", () => {
  it("renders the group; a row opens the child read-only on the right; stop aborts the child", async () => {
    const calls = api({ [`POST ${CHILD}/abort`]: () => json(202, { runId: "run-ch2" }) });
    renderChat();
    const row = await rowOf("Check tests");
    expect(group()?.textContent).toContain("1 subagents running");
    const user = userEvent.setup();
    await user.click(row);
    expect(window.location.hash).toBe("#subagent=ch2");
    expect(row.getAttribute("aria-current")).toBe("true");
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    // the task, then the agent · subagent · model · tools line
    expect(await within(panel).findByText("Do Check tests")).toBeTruthy();
    expect(panel.querySelector('[data-part="subagent-meta"]')?.textContent).toBe(
      "Echo agent › general-purpose · subagent · fake-1 · sandbox_bash",
    );
    expect(await within(panel).findByText("All tests pass.")).toBeTruthy();
    // one live thread: the panel's record does not announce (I2)
    expect(within(panel).getByRole("log").getAttribute("aria-live")).toBe("off");
    expect(panel.querySelector('[data-entry="tools"]')?.getAttribute("data-tool-keys")).toBe(
      "sandbox_bash",
    );
    expect(panel.textContent).toContain(en.subagents.view.readOnly);
    // read-only: no composer inside, the child's own stream
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(FakeEventSource.instances.some((s) => s.url.startsWith(`${CHILD}/stream`))).toBe(true);
    await user.click(within(panel).getByRole("button", { name: en.subagents.view.stop }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${CHILD}/abort`)).toBe(true),
    );
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Check tests" })).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("a finished child shows no stop", async () => {
    api({}, { child: childEvents(false) });
    window.history.replaceState(null, "", "/chat/c1#subagent=ch2");
    renderChat();
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    expect(await within(panel).findByText("All tests pass.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: en.subagents.view.stop })).toBeNull();
  });

  it("an org agent's name in the task line links to the agent", async () => {
    const child = childEvents(false).map((e) =>
      e.type === "subagent_started"
        ? ({
            ...e,
            payload: {
              ...e.payload,
              template: { source: "agent", id: "ag1", version: 2 },
              definition: { ...(e.payload as { definition: object }).definition, name: "Reviewer" },
            },
          } as ConversationEvent)
        : e,
    );
    api({}, { child });
    window.history.replaceState(null, "", "/chat/c1#subagent=ch2");
    renderChat();
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    const link = await within(panel).findByRole("link", { name: "Reviewer" });
    expect(link.getAttribute("href")).toContain("/agents/ag1");
  });

  it("?subagent= (inbox and IM links) opens that child and becomes the hash", async () => {
    api();
    window.history.replaceState(null, "", "/chat/c1?subagent=ch2");
    renderChat();
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    expect(await within(panel).findByText("All tests pass.")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#subagent=ch2");
  });

  it("#subagent= naming a conversation that is not a child of this one fails, with no stop", async () => {
    api({
      [`GET ${CHILD}`]: () => json(200, CONV("ch2", { parentConversationId: null })),
    });
    window.history.replaceState(null, "", "/chat/c1#subagent=ch2");
    renderChat();
    const panel = await screen.findByRole("complementary", { name: en.subagents.view.title });
    expect(await within(panel).findByText(en.subagents.view.loadFailed)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: en.subagents.view.stop })).toBeNull();
    expect(within(panel).queryByText("All tests pass.")).toBeNull();
  });

  it("the parent's subagent_progress updates the row's calls", async () => {
    api();
    renderChat();
    const row = await rowOf("Check tests");
    const es = FakeEventSource.instances.find((s) => s.url.startsWith(`${PARENT}/stream`));
    act(() => es?.emit("subagent_progress", { subagentId: "ch2", step: 3, toolCalls: 5 }));
    expect(row.textContent).toContain("5 calls");
  });

  it("a child's approval shows in the parent with its name and decides the child's approval", async () => {
    const calls = api(
      {
        [`GET ${ORG}/approvals/ap1`]: () =>
          json(200, {
            approval: {
              id: "ap1",
              conversationId: "ch2",
              runId: "run-ch2",
              callId: "x1",
              toolKey: "sandbox_bash",
              toolName: "sandbox_bash",
              connector: null,
              agent: { id: "ag1", name: "Lead" },
              input: { command: "rm -rf build" },
              requestedFor: "a1",
              approverRole: null,
              status: "pending",
              scope: null,
              decidedBy: null,
              decidedAt: null,
              expiresAt: "2026-10-26T08:00:00.000Z",
              createdAt: "2026-10-26T06:00:00.000Z",
              conversationPath: "/chat/c1?subagent=ch2",
              parentConversationId: "c1",
              initiatorAccountId: "a1",
            },
          }),
        [`POST ${ORG}/approvals/ap1/decision`]: () =>
          json(200, {
            approval: { id: "ap1", status: "approved", scope: "once", decidedBy: "a1" },
          }),
      },
      { parent: [...parentEvents(), waiting(8, { kind: "approval", approvalId: "ap1" })] },
    );
    renderChat();
    const card = await vi.waitFor(() => {
      const c = document.querySelector('[data-entry="subagent-wait"]');
      if (c === null) throw new Error("no card yet");
      return c as HTMLElement;
    });
    expect(card.textContent).toContain(en.subagents.askedBy.replace("{name}", "Check tests"));
    expect(await within(card).findByText(/rm -rf build/)).toBeTruthy();
    await userEvent.setup().click(await within(card).findByRole("button", { name: "Approve" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        decision: "approve",
        scope: "once",
      }),
    );
  });

  it("someone else's child approval is a waiting line (the starter decides)", async () => {
    api(
      {
        [`GET ${ORG}/approvals/ap1`]: () =>
          json(404, { error: { code: "approval.not_found", message: "x" } }),
      },
      { parent: [...parentEvents(), waiting(8, { kind: "approval", approvalId: "ap1" })] },
    );
    renderChat();
    // the waiting line, once the read said no (pending, the block shows until then)
    const line = en.approval.otherApproverFor
      .replace("{tool}", "sandbox_bash")
      .replace("{key}", "sandbox_bash");
    const card = await vi.waitFor(() => {
      const c = document.querySelector('[data-entry="subagent-wait"] [data-role="approval"]');
      if (c?.textContent !== line) throw new Error("no line yet");
      return c as HTMLElement;
    });
    expect(within(card).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("a child's question renders with its name; one for someone else is a line", async () => {
    const question = {
      id: "q1",
      conversationId: "ch2",
      toolKey: "ask_user",
      form: {
        title: "Pick a region",
        fields: [{ key: "region", label: "Region", schema: { type: "string" } }],
      },
      status: "pending",
      answer: null,
      answeredBy: null,
      expiresAt: "2026-10-26T08:00:00.000Z",
    };
    api(
      {
        [`GET ${ORG}/questions/q1`]: () => json(200, { question }),
        [`GET ${ORG}/questions/q9`]: () =>
          json(404, { error: { code: "question.not_found", message: "x" } }),
      },
      {
        parent: [
          ...parentEvents(),
          waiting(8, { kind: "input", questionId: "q1", toolKey: "ask_user" }),
          waiting(9, { kind: "input", questionId: "q9", toolKey: "ask_user" }),
        ],
      },
    );
    renderChat();
    const card = await vi.waitFor(() => {
      const c = document.querySelector('[data-question-id="q1"]');
      if (c === null) throw new Error("no card yet");
      return c.closest('[data-entry="subagent-wait"]') as HTMLElement;
    });
    expect(card.textContent).toContain(en.subagents.askedBy.replace("{name}", "Check tests"));
    expect(card.textContent).toContain("Pick a region");
    const line = await vi.waitFor(() => {
      const c = document.querySelector('[data-role="subagent-question-elsewhere"]');
      if (c === null) throw new Error("no line yet");
      return c as HTMLElement;
    });
    expect(line.textContent).toBe(en.subagents.questionElsewhere.replace("{name}", "Check tests"));
  });

  it("a child that needs a connection: a line in the parent that opens the child", async () => {
    api({}, { parent: [...parentEvents(), waiting(8, { kind: "connect", toolKey: "gh__issue" })] });
    renderChat();
    const line = await vi.waitFor(() => {
      const c = document.querySelector('[data-role="subagent-connect"]');
      if (c === null) throw new Error("no line yet");
      return c as HTMLElement;
    });
    expect(line.textContent).toContain(en.subagents.connect.replace("{name}", "Check tests"));
    await userEvent.setup().click(within(line).getByRole("button", { name: en.subagents.open }));
    expect(window.location.hash).toBe("#subagent=ch2");
  });
});

describe("the properties panel with sub-agents", () => {
  it("background tasks: running ones with stop and open, then the completed count", async () => {
    const calls = api({ [`POST ${CHILD}/abort`]: () => json(202, { runId: "run-ch2" }) });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    const section = (await within(props).findByText(en.subagents.background)).closest(
      '[data-part="property-section"]',
    ) as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: /Stop Check tests/ }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${CHILD}/abort`)).toBe(true),
    );
    await user.click(within(section).getByRole("button", { name: /1 completed/ }));
    expect(window.location.hash).toBe("#subagent=ch1");
  });

  it("the Context section shows the total tokens with sub-agents from GET .../usage", async () => {
    api();
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(
      await within(props).findByText(`${en.subagents.contextTotal} 1,234`, { exact: false }),
    ).toBeTruthy();
  });

  it("sections in the spec order: Context, extensions, Files, Background tasks", async () => {
    api({
      [`GET ${PARENT}/files`]: () =>
        json(200, { files: [fileOf("f1", "out.txt", "2026-10-26T06:00:00.000Z")], next: null }),
      [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [TASKS_SECTION] }),
      [`GET ${ORG}/ui/views/todo/tasks-section`]: () =>
        json(200, { view: { blocks: [{ type: "text", text: "nothing to do" }] } }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    await within(props).findByText(en.subagents.background);
    await within(props).findByText("out.txt");
    await within(props).findByText("Tasks");
    expect(sectionTitles(props)).toEqual(["Context", "Tasks", "Files", en.subagents.background]);
  });

  it("the Files section lists the sub-agents' deliveries, marked with the sub-agent; one opens from its child", async () => {
    api({
      [`GET ${PARENT}/files`]: () =>
        json(200, { files: [fileOf("f1", "out.txt", "2026-10-26T06:00:00.000Z")], next: null }),
      [`GET ${CHILD}/files`]: () =>
        json(200, { files: [fileOf("f2", "tree.txt", "2026-10-26T06:00:30.000Z")], next: null }),
      [`GET ${ORG}/conversations/ch1/files`]: () => json(200, { files: [], next: null }),
      [`GET ${CHILD}/files/f2/previewers`]: () => json(200, { previewers: [] }),
      [`GET ${CHILD}/files/f2/content`]: () =>
        new Response("a tree", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    const from = await within(props).findByText("from Check tests");
    const row = from.closest("button") as HTMLElement;
    expect(row.textContent).toContain("tree.txt");
    // newest first; the parent's own file has no marker
    const rows = [...props.querySelectorAll('[data-part="property-row"]')].map(
      (r) => r.textContent,
    );
    expect(rows.findIndex((r) => r?.includes("tree.txt"))).toBeLessThan(
      rows.findIndex((r) => r?.includes("out.txt")),
    );
    expect(within(props).getAllByText(/^from /)).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(row);
    expect(window.location.hash).toBe("#file=f2");
    expect(await screen.findByText("a tree")).toBeTruthy();
  });

  it("Back in a sub-agent opened from the properties panel returns to it", async () => {
    api({}, { child: childEvents(false) });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    const section = (await within(props).findByText(en.subagents.background)).closest(
      '[data-part="property-section"]',
    ) as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "Check tests" }));
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    expect(window.location.hash).toBe("#subagent=ch2");
    await user.click(within(panel).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("complementary", { name: "Properties" })).toBeTruthy();
    expect(window.location.hash).toBe("#properties");
  });

  it("Back in a sub-agent opened from the thread closes the panel", async () => {
    api({}, { child: childEvents(false) });
    renderChat();
    const user = userEvent.setup();
    await user.click(await rowOf("Check tests"));
    const panel = await screen.findByRole("complementary", { name: "Check tests" });
    await user.click(within(panel).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("complementary", { name: "Check tests" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Properties" })).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("no sub-agents: no background section and no total", async () => {
    api({}, { parent: [userMsg(1, "hi")] });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    await within(props).findByText("Context");
    expect(within(props).queryByText(en.subagents.background)).toBeNull();
    expect(within(props).queryByText(en.subagents.contextTotal, { exact: false })).toBeNull();
  });
});

describe("progress seeds (phase C batch 14 review m7)", () => {
  it("a seed after a reconnect raises the calls even when stream progress came first", () => {
    let state = reduceChat(initialChatState, { kind: "events", events: parentEvents() });
    state = reduceChat(state, {
      kind: "progress",
      progress: { subagentId: "ch2", step: 2, toolCalls: 2 },
    });
    state = reduceChat(state, {
      kind: "progress",
      progress: { subagentId: "ch2", step: 0, toolCalls: 6 },
      seed: true,
    });
    expect(state.progress.ch2).toEqual({ subagentId: "ch2", step: 2, toolCalls: 6 });
    const same = reduceChat(state, {
      kind: "progress",
      progress: { subagentId: "ch2", step: 0, toolCalls: 3 },
      seed: true,
    });
    expect(same).toBe(state);
    state = reduceChat(state, {
      kind: "progress",
      progress: { subagentId: "ch2", step: 3, toolCalls: 7 },
    });
    expect(state.progress.ch2?.toolCalls).toBe(7);
  });
});
