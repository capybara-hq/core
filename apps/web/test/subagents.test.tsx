import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { MessageList } from "../src/components/MessageList";
import type { ConversationEvent } from "../src/lib/conversations";
import { type ChatState, chatItems, initialChatState, reduceChat } from "../src/lib/stream";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

/**
 * Phase C Task 18 (interim UI on today's conversation page): the parent's `agent` calls render as
 * one sub-agent group, a row opens the child read-only in the Inspector (with stop), a child's
 * approval shows in the parent with the sub-agent's name, and `?subagent=` opens a child.
 */

let clock = 0;
function ev(
  seq: number,
  type: string,
  payload: unknown,
  runId: string | null = "r1",
  conversationId = "c1",
): ConversationEvent {
  clock += 1000;
  return {
    conversationId,
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(clock).toISOString(),
  } as ConversationEvent;
}

const userMsg = (seq: number, text: string, conv = "c1") =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null, conv);
const runStarted = (seq: number, runId = "r1", conv = "c1") =>
  ev(
    seq,
    "run_started",
    { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } },
    runId,
    conv,
  );

const call = (id: string, description: string, type = "general-purpose") => ({
  type: "tool_call",
  id,
  name: "agent",
  input: { description, prompt: `Do ${description}`, subagent_type: type },
});

const dispatched = (
  seq: number,
  callId: string,
  child: string,
  description: string,
  type = "general-purpose",
) =>
  ev(seq, "subagent_dispatched", {
    step: 1,
    callId,
    subagentId: child,
    childRunId: `run-${child}`,
    agentType: type,
    description,
    resumed: false,
    model: { provider: "model-fake", model: "fake-1" },
  });

const finished = (
  seq: number,
  callId: string,
  child: string,
  status: string,
  toolCalls: number,
  durationMs: number,
) =>
  ev(seq, "subagent_finished", {
    subagentId: child,
    childRunId: `run-${child}`,
    callId,
    status,
    toolCalls,
    durationMs,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

/** A parent that dispatched three sub-agents in one step. */
function threeRunning(): ConversationEvent[] {
  return [
    userMsg(1, "go"),
    runStarted(2),
    ev(3, "assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [
        call("k1", "Scan docs"),
        call("k2", "Check tests"),
        call("k3", "Read logs", "crm:reviewer"),
      ],
    }),
    dispatched(4, "k1", "ch1", "Scan docs"),
    dispatched(5, "k2", "ch2", "Check tests"),
    dispatched(6, "k3", "ch3", "Read logs", "crm:reviewer"),
  ];
}

const stateOf = (events: ConversationEvent[]): ChatState =>
  reduceChat(initialChatState, { kind: "events", events });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sub-agent group in the message list", () => {
  it("three running sub-agents render one group with a row each; progress updates the calls", () => {
    let state = stateOf(threeRunning());
    state = reduceChat(state, {
      kind: "progress",
      progress: { subagentId: "ch2", step: 2, toolCalls: 2, lastToolKey: "sandbox_bash" },
    });
    const { container } = renderPage(<MessageList orgId="o1" items={chatItems(state)} />);
    const group = container.querySelector('[data-role="subagent-group"]') as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.textContent).toContain("3 sub-agents running");
    const rows = group.querySelectorAll('[data-role="subagent"]');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.getAttribute("data-status")).toBe("running");
    expect(rows[1]?.textContent).toContain("Check tests");
    expect(rows[1]?.textContent).toContain("2 calls");
    expect(rows[2]?.textContent).toContain("crm:reviewer");
    // no generic tool rows for agent calls
    expect(container.querySelector('[data-role="tool"]')).toBeNull();
  });

  it.each([
    ["en", en, "3 sub-agents done (1 failed) · 9 calls · 12.0s"],
    ["zh", zh, null],
  ] as const)("finished: done, failed count, calls and duration (%s)", (locale, _m, text) => {
    const events = [
      ...threeRunning(),
      finished(7, "k1", "ch1", "completed", 3, 4000),
      finished(8, "k2", "ch2", "failed", 2, 12000),
      finished(9, "k3", "ch3", "completed", 4, 9000),
      ev(10, "tool_result", {
        step: 1,
        callId: "k1",
        toolKey: "agent",
        content: "ok",
        isError: false,
      }),
      ev(11, "tool_result", {
        step: 1,
        callId: "k2",
        toolKey: "agent",
        content: "boom",
        isError: true,
      }),
      ev(12, "tool_result", {
        step: 1,
        callId: "k3",
        toolKey: "agent",
        content: "ok",
        isError: false,
      }),
    ];
    const { container } = renderPage(
      <MessageList orgId="o1" items={chatItems(stateOf(events))} />,
      {
        locale,
      },
    );
    const group = container.querySelector('[data-role="subagent-group"]') as HTMLElement;
    if (text !== null) expect(group.textContent).toContain(text);
    else expect(group.textContent).toContain("12.0s");
    const rows = group.querySelectorAll('[data-role="subagent"]');
    expect([...rows].map((r) => r.getAttribute("data-status"))).toEqual(["done", "error", "done"]);
  });

  it("a refused agent call (no dispatch) is a failed row with the reason", async () => {
    const events = [
      userMsg(1, "go"),
      runStarted(2),
      ev(3, "assistant_message", {
        step: 1,
        stopReason: "tool_use",
        content: [call("k1", "Use analyst", "analyst")],
      }),
      ev(4, "tool_result", {
        step: 1,
        callId: "k1",
        toolKey: "agent",
        content: "Unknown subagent_type analyst.",
        isError: true,
      }),
    ];
    const { container } = renderPage(<MessageList orgId="o1" items={chatItems(stateOf(events))} />);
    const row = container.querySelector('[data-role="subagent"]') as HTMLElement;
    expect(row.getAttribute("data-status")).toBe("error");
    expect(row.textContent).toContain("Use analyst");
    await userEvent.setup().click(within(row).getByRole("button", { expanded: false }));
    expect(row.textContent).toContain("Unknown subagent_type analyst.");
    // nothing to open
    expect(within(row).queryByRole("button", { name: /Open sub-agent/ })).toBeNull();
  });

  it("clicking a row's open button reports the sub-agent id", async () => {
    const onOpen = vi.fn();
    renderPage(
      <MessageList orgId="o1" items={chatItems(stateOf(threeRunning()))} onOpenSubagent={onOpen} />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open sub-agent Check tests" }));
    expect(onOpen).toHaveBeenCalledWith("ch2");
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

const ORG = "/api/v1/orgs/o1";
const PARENT = `${ORG}/conversations/c1`;
const CHILD = `${ORG}/conversations/ch2`;

/** The child ch2's log: started by call k2 of the parent, then its own task and reply. */
function childEvents(template: object = { source: "general" }): ConversationEvent[] {
  return [
    ev(
      1,
      "subagent_started",
      {
        parent: { conversationId: "c1", runId: "r1", callId: "k2", step: 1 },
        agentType: "general-purpose",
        template,
        definition: {
          name: "Lead › general-purpose",
          tools: [
            { kind: "builtin", name: "sandbox_bash" },
            { kind: "builtin", name: "read_tool_output" },
          ],
        },
        preamble: "p",
        maxSteps: 50,
      },
      null,
      "ch2",
    ),
    userMsg(2, "Do Check tests", "ch2"),
    runStarted(3, "run-ch2", "ch2"),
    ev(
      4,
      "assistant_message",
      { step: 1, stopReason: "end_turn", content: [{ type: "text", text: "All tests pass." }] },
      "run-ch2",
      "ch2",
    ),
  ];
}

function chatRoutes(extra: Record<string, () => Response> = {}, child = childEvents()) {
  return stubApi({
    [`GET ${PARENT}/events`]: () => json(200, { events: threeRunning() }),
    [`GET ${PARENT}`]: () => json(200, { conversation: { id: "c1", agentId: "ag1" } }),
    [`GET ${PARENT}/subagents`]: () => json(200, { subagents: [], next: null }),
    [`GET ${CHILD}/events`]: () => json(200, { events: child }),
    [`GET ${CHILD}`]: () =>
      json(200, {
        conversation: {
          id: "ch2",
          agentId: "ag1",
          parentConversationId: "c1",
          subagentType: "general-purpose",
        },
      }),
    [`GET ${ORG}/agents`]: () =>
      json(200, {
        agents: [
          { id: "ag1", definition: { name: "Lead" } },
          { id: "ag2", definition: { name: "Data analyst" } },
        ],
      }),
    [`GET ${ORG}/models`]: () => json(200, { providers: [] }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${PARENT}/sandbox`]: () => json(200, { sandbox: null }),
    [`GET ${CHILD}/sandbox`]: () => json(200, { sandbox: null }),
    ...extra,
  });
}

describe("the sub-agent view in the Inspector", () => {
  beforeEach(() => {
    resetNavigation("/chat/c1");
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.replaceState(null, "", "/en/chat/c1");
  });
  afterEach(() => {
    FakeEventSource.instances = [];
    window.history.replaceState(null, "", "/");
  });

  it("clicking a row opens the read-only child view with stop; stop aborts the child", async () => {
    const calls = chatRoutes({ [`POST ${CHILD}/abort`]: () => json(202, { runId: "run-ch2" }) });
    renderPage(<ChatPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open sub-agent Check tests" }));
    const view = await screen.findByRole("region", { name: en.subagents.view.title });
    expect(window.location.search).toBe("?subagent=ch2");
    expect(await within(view).findByText("All tests pass.")).toBeTruthy();
    expect(within(view).getByText("Do Check tests")).toBeTruthy();
    expect(view.textContent).toContain("general-purpose");
    expect(view.textContent).toContain("sandbox_bash");
    // read-only: no composer inside the view
    expect(within(view).queryByLabelText(en.chat.inputLabel)).toBeNull();
    // the child's stream is opened on its own route
    await vi.waitFor(() =>
      expect(FakeEventSource.instances.some((s) => s.url.startsWith(`${CHILD}/stream`))).toBe(true),
    );
    // the child's log is done: stop shows only while it runs; make it run again
    act(() => {
      const es = FakeEventSource.instances.find((s) => s.url.startsWith(`${CHILD}/stream`));
      es?.emit("event", runStarted(5, "run-ch2b", "ch2"));
    });
    await user.click(await within(view).getByRole("button", { name: en.subagents.view.stop }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${CHILD}/abort`)).toBe(true),
    );
    // back closes the view and drops the query
    await user.click(within(view).getByRole("button", { name: en.subagents.view.back }));
    expect(screen.queryByRole("region", { name: en.subagents.view.title })).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("?subagent= opens that child on load", async () => {
    window.history.replaceState(null, "", "/en/chat/c1?subagent=ch2");
    chatRoutes();
    renderPage(<ChatPage />);
    const view = await screen.findByRole("region", { name: en.subagents.view.title });
    expect(await within(view).findByText("All tests pass.")).toBeTruthy();
  });

  it("an org agent sub-agent shows that agent's name with a link to it", async () => {
    window.history.replaceState(null, "", "/en/chat/c1?subagent=ch2");
    // an org agent child's conversation belongs to the dispatched agent
    chatRoutes(
      {
        [`GET ${CHILD}`]: () =>
          json(200, { conversation: { id: "ch2", agentId: "ag2", parentConversationId: "c1" } }),
      },
      childEvents({ source: "agent", id: "ag2", version: 3 }),
    );
    renderPage(<ChatPage />);
    const view = await screen.findByRole("region", { name: en.subagents.view.title });
    const link = await within(view).findByRole("link", { name: "Data analyst" });
    expect(link.getAttribute("href")).toBe("/agents/ag2");
  });

  it("?subagent= with a conversation that is not a child of this one shows loadFailed, no stop (batch 14 review m1)", async () => {
    window.history.replaceState(null, "", "/en/chat/c1?subagent=ch2");
    chatRoutes({
      [`GET ${CHILD}`]: () =>
        json(200, { conversation: { id: "ch2", agentId: "ag1", parentConversationId: null } }),
    });
    renderPage(<ChatPage />);
    const view = await screen.findByRole("region", { name: en.subagents.view.title });
    expect(await within(view).findByText(en.subagents.view.loadFailed)).toBeTruthy();
    expect(within(view).queryByRole("button", { name: en.subagents.view.stop })).toBeNull();
    expect(within(view).queryByText("All tests pass.")).toBeNull();
  });

  it("the parent's SSE subagent_progress updates the row's calls", async () => {
    chatRoutes();
    renderPage(<ChatPage />);
    await screen.findByRole("button", { name: "Open sub-agent Check tests" });
    const es = FakeEventSource.instances.find((s) => s.url.startsWith(`${PARENT}/stream`));
    act(() => es?.emit("subagent_progress", { subagentId: "ch2", step: 3, toolCalls: 5 }));
    const row = document.querySelector('[data-subagent-id="ch2"]') as HTMLElement;
    expect(row.textContent).toContain("5 calls");
  });
});

describe("a sub-agent's approval in the parent", () => {
  beforeEach(() => {
    resetNavigation("/chat/c1");
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it("renders the approval card with the sub-agent's name and decides the child's approval", async () => {
    const calls = stubApi({
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
            expiresAt: new Date(10_000_000).toISOString(),
            createdAt: new Date(0).toISOString(),
            conversationPath: "/chat/c1?subagent=ch2",
            parentConversationId: "c1",
            initiatorAccountId: "a1",
          },
        }),
      [`POST ${ORG}/approvals/ap1/decision`]: () =>
        json(200, {
          approval: { id: "ap1", status: "approved", scope: "once", decidedBy: "a1" },
        }),
    });
    const events = [
      ...threeRunning(),
      ev(7, "subagent_waiting", {
        subagentId: "ch2",
        childRunId: "run-ch2",
        kind: "approval",
        approvalId: "ap1",
        toolKey: "sandbox_bash",
        expiresAt: new Date(10_000_000).toISOString(),
      }),
    ];
    renderPage(
      <MessageList orgId="o1" items={chatItems(stateOf(events))} onOpenSubagent={() => {}} />,
    );
    const card = document.querySelector('[data-approval-id="ap1"]') as HTMLElement;
    expect(card.textContent).toContain("Check tests");
    expect(await within(card).findByText(/rm -rf build/)).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole("button", { name: en.approval.approve }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        decision: "approve",
        scope: "once",
      }),
    );
  });

  it("a sub-agent's question renders the question card with its name", async () => {
    stubApi({
      [`GET ${ORG}/questions/q1`]: () =>
        json(200, {
          question: {
            id: "q1",
            conversationId: "ch2",
            toolKey: "crm__pick",
            form: {
              title: "Pick a region",
              fields: [{ key: "region", label: "Region", schema: { type: "string" } }],
            },
            status: "pending",
            answer: null,
            answeredBy: null,
            expiresAt: new Date(10_000_000).toISOString(),
          },
        }),
    });
    const events = [
      ...threeRunning(),
      ev(7, "subagent_waiting", {
        subagentId: "ch3",
        childRunId: "run-ch3",
        kind: "input",
        questionId: "q1",
        toolKey: "crm__pick",
      }),
    ];
    renderPage(<MessageList orgId="o1" items={chatItems(stateOf(events))} />);
    const card = await vi.waitFor(() => {
      const c = document.querySelector('[data-question-id="q1"]');
      if (c === null) throw new Error("no card yet");
      return c as HTMLElement;
    });
    expect(card.textContent).toContain("Read logs");
    expect(card.textContent).toContain("Pick a region");
  });
});

describe("a sub-agent's question for someone else (batch 14 review m4)", () => {
  it("shows a line naming the sub-agent instead of nothing", async () => {
    stubApi({
      [`GET ${ORG}/questions/q9`]: () =>
        json(404, { error: { code: "question.not_found", message: "Not found" } }),
    });
    const events = [
      ...threeRunning(),
      ev(7, "subagent_waiting", {
        subagentId: "ch3",
        childRunId: "run-ch3",
        kind: "input",
        questionId: "q9",
        toolKey: "crm__pick",
      }),
    ];
    renderPage(<MessageList orgId="o1" items={chatItems(stateOf(events))} />);
    const line = await vi.waitFor(() => {
      const c = document.querySelector('[data-role="subagent-question-elsewhere"]');
      if (c === null) throw new Error("no line yet");
      return c as HTMLElement;
    });
    expect(line.textContent).toBe(en.subagents.questionElsewhere.replace("{name}", "Read logs"));
  });
});

describe("progress seeds (batch 14 review m7)", () => {
  it("a seed after a reconnect raises the calls even when stream progress came first", () => {
    let state = stateOf(threeRunning());
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
    // an older seed does not lower them, and a later stream step still applies
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

describe("the Context tab with sub-agents", () => {
  beforeEach(() => {
    resetNavigation("/chat/c1");
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it("shows the total tokens with sub-agents from GET .../usage", async () => {
    chatRoutes({
      [`GET ${PARENT}/usage`]: () =>
        json(200, {
          usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 34, cacheWriteTokens: 0 },
        }),
    });
    renderPage(<ChatPage />);
    const inspector = screen.getByRole("complementary");
    await userEvent
      .setup()
      .click(within(inspector).getByRole("tab", { name: new RegExp(en.chatPanel.context) }));
    expect(await within(inspector).findByText(en.subagents.contextTotal)).toBeTruthy();
    expect(await within(inspector).findByText("1,234")).toBeTruthy();
  });
});
