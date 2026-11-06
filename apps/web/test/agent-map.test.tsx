import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { agentTreeNodes, liveStatus, logWord } from "../src/components/conversation/AgentMap";
import type { AgentTreeNode, ConversationEvent } from "../src/lib/conversations";
import { TREE_PROGRESS_MS } from "../src/lib/subagents";
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
 * Agent map spec §9.2 (Task C1): the agent map's level 1 opened from the conversation page, from
 * the sub-agent group's header and from a title-bar icon shown while the conversation has
 * sub-agents; the dialog lives in the URL hash (`#agents`) and reads `GET …/agent-tree`, again
 * when a sub-agent event or progress arrives.
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
const MAP = en.chat.agentMap;

const call = (id: string, description: string) => ({
  type: "tool_call",
  id,
  name: "Agent",
  input: { description, prompt: `Do ${description}`, subagent_type: "general-purpose" },
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
    background: true,
    model: { provider: "model-fake", model: "fake-1" },
  });

const parentEvents = (): ConversationEvent[] => [
  userMsg(1, "go"),
  runStarted(2),
  ev(3, "assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: [call("k1", "Scan docs")],
  }),
  dispatched(4, "k1", "ch1", "Scan docs"),
];

const node = (over: Partial<AgentTreeNode> & { id: string }): AgentTreeNode => ({
  description: "",
  agentType: "general-purpose",
  status: "running",
  model: { provider: "model-fake", model: "fake-1" },
  startedAt: "2026-10-26T06:00:04.000Z",
  finishedAt: null,
  durationMs: 41_000,
  tokens: 1200,
  toolCalls: 2,
  children: [],
  ...over,
});

const tree = (childStatus: AgentTreeNode["status"]) => ({
  root: node({
    id: "c1",
    description: "Release notes",
    agentType: null,
    status: "idle",
    children: [
      node({
        id: "ch1",
        description: "Scan docs",
        status: childStatus,
        children: [node({ id: "gc1", description: "Read the changelog", agentType: null })],
      }),
    ],
  }),
});

const CHILD = `${ORG}/conversations/ch1`;
const GRANDCHILD = `${ORG}/conversations/gc1`;

/** The child's log: started, its task, a read, a parent's message, then a running command. */
function childEvents(id = "ch1", parent = "c1", task = "Do Scan docs"): ConversationEvent[] {
  const c = (seq: number, type: string, payload: unknown, runId: string | null = `run-${id}`) =>
    ev(seq, type, payload, runId, id);
  return [
    c(
      1,
      "subagent_started",
      {
        parent: { conversationId: parent, runId: "r1", callId: "k1", step: 1 },
        agentType: "general-purpose",
        template: { source: "general" },
        definition: { name: "general-purpose", tools: [{ kind: "builtin", name: "Read" }] },
        maxSteps: 20,
      },
      null,
    ),
    c(
      2,
      "user_message",
      {
        content: [{ type: "text", text: task }],
        authorAccountId: "a1",
        dispatch: { parentConversationId: parent, parentRunId: "r1", callId: "k1" },
      },
      null,
    ),
    c(3, "run_started", { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } }),
    c(4, "assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [
        { type: "text", text: "Reading the docs first." },
        { type: "tool_call", id: "x1", name: "Read", input: { file_path: "docs/a.md" } },
      ],
    }),
    c(5, "tool_result", {
      step: 1,
      callId: "x1",
      toolKey: "Read",
      content: "# A",
      isError: false,
      view: { kind: "read", path: "docs/a.md", fromLine: 1, toLine: 180 },
    }),
    c(
      6,
      "user_message",
      {
        content: [{ type: "text", text: "Focus on the API docs" }],
        authorAccountId: "a1",
        dispatch: {
          parentConversationId: parent,
          parentRunId: "r1",
          callId: "s1",
          kind: "message",
        },
      },
      null,
    ),
    c(7, "assistant_message", {
      step: 2,
      stopReason: "tool_use",
      content: [
        {
          type: "tool_call",
          id: "x2",
          name: "Bash",
          input: { command: "pnpm test", description: "Run the tests" },
        },
      ],
    }),
    c(8, "tool_call_started", { step: 2, callId: "x2", toolKey: "Bash", specHash: "h" }),
  ];
}

function api(
  events: ConversationEvent[],
  answer: () => Response = () => json(200, tree("running")),
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
): Call[] {
  return stubApi({
    [`GET ${CHILD}`]: () => json(200, CONV("ch1", { parentConversationId: "c1" })),
    [`GET ${CHILD}/events`]: () => json(200, { events: childEvents() }),
    [`GET ${CHILD}/tools`]: () => json(200, { tools: [] }),
    [`GET ${GRANDCHILD}`]: () => json(200, CONV("gc1", { parentConversationId: "ch1" })),
    [`GET ${GRANDCHILD}/events`]: () =>
      json(200, { events: childEvents("gc1", "ch1", "Do Read the changelog") }),
    [`GET ${GRANDCHILD}/tools`]: () => json(200, { tools: [] }),
    ...extra,
    [`GET ${PARENT}`]: () => json(200, CONV("c1")),
    [`GET ${PARENT}/events`]: () => json(200, { events }),
    [`GET ${PARENT}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${PARENT}/tools`]: () => json(200, { tools: [] }),
    [`GET ${PARENT}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${PARENT}/sandbox`]: () =>
      json(404, { error: { code: "sandbox.not_found", message: "x" } }),
    [`GET ${PARENT}/subagents`]: () => json(200, { subagents: [], next: null }),
    [`GET ${PARENT}/background-tasks`]: () => json(200, { tasks: [] }),
    [`GET ${PARENT}/usage`]: () =>
      json(200, {
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    [`GET ${PARENT}/agent-tree`]: answer,
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
  });
}

const treeReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.endsWith("/agent-tree")).length;
const titleBar = () => document.querySelector('[data-part="title-bar"]') as HTMLElement;
const mapDialog = () => screen.findByRole("dialog", { name: MAP });

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

describe("agentTreeNodes", () => {
  it("maps idle to completed and queued to running, labels the model, keeps the tree", () => {
    const root = agentTreeNodes(
      node({
        id: "c1",
        description: "",
        status: "idle",
        children: [
          node({ id: "a", status: "queued", model: null }),
          node({ id: "b", status: "aborted" }),
        ],
      }),
      "en",
      { untitled: "Untitled" },
    );
    expect(root.status).toBe("completed");
    expect(root.description).toBe("Untitled");
    expect(root.model).toBe("model-fake / fake-1");
    expect(root.children.map((c) => [c.id, c.status, c.model])).toEqual([
      ["a", "running", "—"],
      ["b", "aborted", "model-fake / fake-1"],
    ]);
  });
});

describe("the agent map's entry points", () => {
  it("the group header action opens the tree", async () => {
    api(parentEvents());
    await renderChatRoute();
    const group = (await waitFor(() => {
      const g = document.querySelector('[data-entry="subagents"]');
      expect(g).not.toBeNull();
      return g;
    })) as HTMLElement;
    await userEvent.setup().click(within(group).getByRole("button", { name: MAP }));
    expect(window.location.hash).toBe("#agents");
    const dialog = await mapDialog();
    expect(await within(dialog).findByText("Read the changelog")).toBeTruthy();
    expect(within(dialog).getByText("Scan docs")).toBeTruthy();
    expect(within(dialog).getByText("Release notes")).toBeTruthy();
    // closing it clears the hash
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: MAP })).toBeNull());
    expect(window.location.hash).toBe("");
  });

  it("the title-bar icon shows only while the conversation has sub-agents", async () => {
    api([userMsg(1, "go"), runStarted(2)]);
    await renderChatRoute();
    await screen.findByText("go");
    expect(within(titleBar()).queryByRole("button", { name: MAP })).toBeNull();
    cleanup();

    const calls = api(parentEvents());
    await renderChatRoute();
    const icon = await within(titleBar()).findByRole("button", { name: MAP });
    // the tree is read only once the map opens
    expect(treeReads(calls)).toBe(0);
    await userEvent.setup().click(icon);
    expect(window.location.hash).toBe("#agents");
    expect(await within(await mapDialog()).findByText("Read the changelog")).toBeTruthy();
    // the dialog is modal: the page under it is hidden from the accessibility tree
    const pressed = within(titleBar()).getByRole("button", { name: MAP, hidden: true });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
  });

  it("open properties, open the map, close the map: the properties are back", async () => {
    api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    expect(await screen.findByRole("complementary", { name: "Properties" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await within(titleBar()).findByRole("button", { name: MAP }));
    expect(window.location.hash).toBe("#agents");
    const dialog = await mapDialog();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: MAP })).toBeNull());
    expect(window.location.hash).toBe("#properties");
    expect(await screen.findByRole("complementary", { name: "Properties" })).toBeTruthy();
  });

  it("#agents on a conversation without sub-agents is dropped from the hash", async () => {
    const calls = api([userMsg(1, "go"), runStarted(2)]);
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    await screen.findByText("go");
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(screen.queryByRole("dialog", { name: MAP })).toBeNull();
    expect(treeReads(calls)).toBe(0);
  });

  it("a sub-agent conversation's own page has no map entries and reads no tree", async () => {
    params.conversationId = "ch1";
    resetNavigation("/chat/ch1");
    const childSubagent = [
      ...childEvents(),
      ev(
        9,
        "assistant_message",
        { step: 3, stopReason: "tool_use", content: [call("ka", "Read the changelog")] },
        "run-ch1",
        "ch1",
      ),
      ev(
        10,
        "subagent_dispatched",
        {
          step: 3,
          callId: "ka",
          subagentId: "gc1",
          childRunId: "run-gc1",
          agentType: "general-purpose",
          description: "Read the changelog",
          resumed: false,
          model: { provider: "model-fake", model: "fake-1" },
        },
        "run-ch1",
        "ch1",
      ),
    ];
    const calls = api(parentEvents(), undefined, {
      [`GET ${CHILD}/events`]: () => json(200, { events: childSubagent }),
      [`GET ${CHILD}/queue`]: () => json(200, { items: [], paused: false }),
      [`GET ${CHILD}/files`]: () => json(200, { files: [], next: null }),
      [`GET ${CHILD}/sandbox`]: () =>
        json(404, { error: { code: "sandbox.not_found", message: "x" } }),
      [`GET ${CHILD}/subagents`]: () => json(200, { subagents: [], next: null }),
      [`GET ${CHILD}/background-tasks`]: () => json(200, { tasks: [] }),
      [`GET ${CHILD}/usage`]: () =>
        json(200, {
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      [`GET ${CHILD}/agent-tree`]: () =>
        json(404, { error: { code: "conversation.not_found", message: "x" } }),
    });
    window.history.replaceState(null, "", "/chat/ch1#agents");
    await renderChatRoute({ id: "ch1" });
    await screen.findByText("Reading the docs first.");
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(within(titleBar()).queryByRole("button", { name: MAP })).toBeNull();
    const group = document.querySelector('[data-entry="subagents"]') as HTMLElement;
    expect(within(group).queryByRole("button", { name: MAP })).toBeNull();
    expect(within(group).queryByRole("button", { name: "View in agent map" })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/agent-tree"))).toBe(false);
  });

  it("#agents survives a reload: the map opens from the hash", async () => {
    api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    expect(await within(await mapDialog()).findByText("Scan docs")).toBeTruthy();
  });
});

describe("the agent map's tree", () => {
  it("a subagent_finished event refreshes the tree", async () => {
    let status: AgentTreeNode["status"] = "running";
    const calls = api(parentEvents(), () => json(200, tree(status)));
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    const dialog = await mapDialog();
    const scan = await within(dialog).findByText("Scan docs");
    const dotOf = () =>
      scan
        .closest('[data-part="agent-node"]')
        ?.querySelector('[data-part="agent-dot"]')
        ?.getAttribute("data-status");
    expect(dotOf()).toBe("running");
    const before = treeReads(calls);
    status = "idle";
    act(() => {
      FakeEventSource.instances[0]?.emit(
        "event",
        ev(5, "subagent_finished", {
          subagentId: "ch1",
          childRunId: "run-ch1",
          callId: "k1",
          status: "completed",
          toolCalls: 2,
          durationMs: 41_000,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );
    });
    await waitFor(() => expect(treeReads(calls)).toBeGreaterThan(before));
    await waitFor(() => expect(dotOf()).toBe("completed"));
  });

  it("a grandchild's progress refreshes the tree", async () => {
    const calls = api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    await within(await mapDialog()).findByText("Read the changelog");
    const before = treeReads(calls);
    act(() => {
      FakeEventSource.instances[0]?.emit("subagent_progress", {
        subagentId: "gc1",
        step: 1,
        toolCalls: 1,
        lastToolKey: "Read",
      });
    });
    // progress is coalesced: the read comes at the end of the throttle window
    await waitFor(() => expect(treeReads(calls)).toBeGreaterThan(before), {
      timeout: TREE_PROGRESS_MS + 1500,
    });
  });
});

const childStream = () =>
  FakeEventSource.instances.find((s) => s.url.startsWith(`${CHILD}/stream`));
const detailDialog = () => screen.findByRole("dialog", { name: "Scan docs" });

describe("the agent map's levels 2 and 3", () => {
  it("level 2 lists the child's tool calls newest first from its events", async () => {
    api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    // the latest text and the task come from the child's own log
    expect(await within(dialog).findByText("Reading the docs first.")).toBeTruthy();
    const rows = await waitFor(() => {
      const r = [...dialog.querySelectorAll('[data-part="agent-call"]')];
      expect(r).toHaveLength(2);
      return r;
    });
    expect(rows.map((r) => r.querySelector('[data-part="agent-call-tool"]')?.textContent)).toEqual([
      "Bash",
      "Read",
    ]);
    expect(rows[0]?.querySelector('[data-part="agent-call-summary"]')?.textContent).toBe(
      "Run the tests",
    );
    expect(rows[0]?.getAttribute("data-running")).toBe("true");
    expect(rows[1]?.querySelector('[data-part="agent-call-summary"]')?.textContent).toBe(
      "docs/a.md",
    );
    expect(rows[1]?.querySelector('[data-part="agent-call-range"]')?.textContent).toBe(
      "lines 1–180",
    );
    // spawned by the root, which opens the tree
    const spawned = dialog.querySelector('[data-part="agent-spawned-by"]') as HTMLElement;
    expect(spawned.textContent).toBe("Spawned by Release notes");
    const user = userEvent.setup();
    await user.click(within(spawned).getByRole("button", { name: "Release notes" }));
    expect(window.location.hash).toBe("#agents");
    expect(await within(await mapDialog()).findByText("Read the changelog")).toBeTruthy();
  });

  it("Stop calls abortRun with the child id and is absent once finished", async () => {
    const calls = api(parentEvents(), undefined, {
      [`POST ${CHILD}/abort`]: () => json(202, { runId: "run-ch1" }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    const stop = await within(dialog).findByRole("button", { name: "Stop" });
    await userEvent.setup().click(stop);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${CHILD}/abort`)).toBe(true),
    );
    // only this child: the parent's own run is not stopped
    expect(calls.some((c) => c.method === "POST" && c.url === `${PARENT}/abort`)).toBe(false);
    await waitFor(() => expect(childStream()).toBeTruthy());
    act(() => {
      childStream()?.emit(
        "event",
        ev(9, "run_aborted", { byAccountId: "a1", reason: "user" }, "run-ch1", "ch1"),
      );
    });
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull());
    expect(within(dialog).getByRole("button", { name: "Open transcript" })).toBeTruthy();
  });

  it("level 3 renders the child's Thread without a composer", async () => {
    api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const user = userEvent.setup();
    await user.click(
      await within(await detailDialog()).findByRole("button", { name: "Open transcript" }),
    );
    expect(window.location.hash).toBe("#agents=ch1/transcript");
    const dialog = await detailDialog();
    const log = await within(dialog).findByRole("log");
    // the task first, then the parent's message, both labelled with the parent
    const bubbles = await waitFor(() => {
      const b = [...log.querySelectorAll('[data-entry="task"], [data-entry="user"]')];
      expect(b).toHaveLength(2);
      return b;
    });
    expect(bubbles[0]?.textContent).toContain("Do Scan docs");
    expect(bubbles[1]?.textContent).toContain("Focus on the API docs");
    for (const b of bubbles)
      expect(b.querySelector('[data-part="bubble-sender"]')?.textContent).toBe(
        "From Release notes",
      );
    // the conversation's own tool groups, collapsed
    expect(log.querySelector('[data-entry="tools"]')).not.toBeNull();
    // read-only: no composer, the child's own stream, one live thread on the page
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(log.getAttribute("aria-live")).toBe("off");
    // no read-only copy in the status line (AC1): the missing composer says it; Stop stays
    const status = dialog.querySelector('[data-part="agent-transcript-status"]') as HTMLElement;
    expect(status.textContent).not.toMatch(/Read-only|pass it on/);
    expect(within(status).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(childStream()).toBeTruthy();
    // back returns to level 2
    await user.click(within(dialog).getByRole("button", { name: "Back to the agent map" }));
    expect(window.location.hash).toBe("#agents=ch1");
    expect(
      await within(await detailDialog()).findByRole("button", { name: "Open transcript" }),
    ).toBeTruthy();
  });

  it("the Agent call block shows the child's current tool and opens level 2", async () => {
    api(parentEvents());
    await renderChatRoute();
    const block = (await waitFor(() => {
      const b = document.querySelector('[data-part="agent-call-block"]');
      expect(b).not.toBeNull();
      return b;
    })) as HTMLElement;
    act(() => {
      FakeEventSource.instances[0]?.emit("subagent_progress", {
        subagentId: "ch1",
        step: 1,
        toolCalls: 1,
        lastToolKey: "Read",
      });
    });
    await waitFor(() =>
      expect(block.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
        "Working in the background: Read",
      ),
    );
    await userEvent.setup().click(within(block).getByRole("button", { name: "View in agent map" }));
    expect(window.location.hash).toBe("#agents=ch1");
    expect(
      await within(await detailDialog()).findByRole("button", { name: "Open transcript" }),
    ).toBeTruthy();
  });
});

describe("deliveries in the parent", () => {
  const delivery = (seq: number, payload: Record<string, unknown>) =>
    ev(seq, "subagent_delivery", {
      subagentId: "ch1",
      childRunId: "run-ch1",
      description: "Scan docs",
      triggerAccountId: "a1",
      text: "",
      ...payload,
    });

  it("a report shows its text on demand; a finish without text opens the agent", async () => {
    api([
      ...parentEvents(),
      delivery(5, { kind: "report", text: "Docs are fine." }),
      delivery(6, { kind: "finished", status: "completed", handedBack: true }),
    ]);
    await renderChatRoute();
    const rows = await waitFor(() => {
      const r = [...document.querySelectorAll<HTMLElement>('[data-entry="delivery"]')];
      expect(r).toHaveLength(2);
      return r;
    });
    const [report, done] = rows as [HTMLElement, HTMLElement];
    expect(report.textContent).toContain(en.chat.delivery.report.replace("{name}", "Scan docs"));
    expect(report.textContent).not.toContain("Docs are fine.");
    const user = userEvent.setup();
    await user.click(within(report).getByRole("button", { name: en.chat.delivery.show }));
    expect(await within(report).findByText("Docs are fine.")).toBeTruthy();
    expect(done.textContent).toContain(en.chat.delivery.completed.replace("{name}", "Scan docs"));
    await user.click(within(done).getByRole("button", { name: "Open" }));
    expect(window.location.hash).toBe("#agents=ch1");
  });
});

describe("nested agents (agent map spec §7)", () => {
  const gcDialog = () => screen.findByRole("dialog", { name: "Read the changelog" });
  const grandchildStream = () =>
    FakeEventSource.instances.find((s) => s.url.startsWith(`${GRANDCHILD}/stream`));

  it("a grandchild: Stop aborts it (its stream ends it); its transcript is its own thread", async () => {
    const calls = api(parentEvents(), undefined, {
      [`POST ${GRANDCHILD}/abort`]: () => json(202, { runId: "run-gc1" }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=gc1");
    await renderChatRoute();
    const dialog = await gcDialog();
    expect(
      (
        await waitFor(() => {
          const el = dialog.querySelector('[data-part="agent-spawned-by"]');
          expect(el).not.toBeNull();
          return el;
        })
      )?.textContent,
    ).toBe("Spawned by Scan docs");
    const reads = () =>
      calls.filter((c) => c.method === "GET" && c.url.startsWith(`${GRANDCHILD}/events`)).length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    const user = userEvent.setup();
    await user.click(await within(dialog).findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === `${GRANDCHILD}/abort`)).toBe(true),
    );
    expect(calls.some((c) => c.method === "POST" && c.url === `${CHILD}/abort`)).toBe(false);
    // its own stream (open at this level) brings the terminal event: the log is not read again
    await act(async () => await new Promise((r) => setTimeout(r, 50)));
    expect(reads()).toBe(before);
    act(() => {
      grandchildStream()?.emit(
        "event",
        ev(9, "run_aborted", { byAccountId: "a1", reason: "user" }, "run-gc1", "gc1"),
      );
    });
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull());
    await user.click(within(dialog).getByRole("button", { name: "Open transcript" }));
    expect(window.location.hash).toBe("#agents=gc1/transcript");
    const log = await within(await gcDialog()).findByRole("log");
    const task = await waitFor(() => {
      const el = log.querySelector('[data-entry="task"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(task.textContent).toContain("Do Read the changelog");
    expect(task.querySelector('[data-part="bubble-sender"]')?.textContent).toBe("From Scan docs");
  });

  it("a deep agent's wait in the root is named from the tree and opens it in the map", async () => {
    const calls = api([
      ...parentEvents(),
      ev(5, "subagent_waiting", {
        subagentId: "gc1",
        childRunId: "run-gc1",
        path: ["ch1", "gc1"],
        kind: "connect",
        toolKey: "mcp__gh__issue",
      }),
    ]);
    await renderChatRoute();
    const line = await waitFor(() => {
      const c = document.querySelector('[data-role="subagent-connect"]');
      expect(c?.textContent).toContain(
        en.subagents.connect.replace("{name}", "Read the changelog"),
      );
      return c as HTMLElement;
    });
    // the tree is read for the name while the map is closed
    expect(treeReads(calls)).toBeGreaterThan(0);
    // its transcript: the thread there holds the card to decide or connect
    await userEvent.setup().click(within(line).getByRole("button", { name: en.subagents.open }));
    expect(window.location.hash).toBe("#agents=gc1/transcript");
    expect(await within(await gcDialog()).findByRole("log")).toBeTruthy();
  });

  it("?subagent= (inbox and IM links, any depth) opens the agent's transcript with its approval", async () => {
    const waiting = [
      ...childEvents("gc1", "ch1", "Do Read the changelog"),
      ev(
        9,
        "approval_requested",
        {
          step: 2,
          callId: "x2",
          approvalId: "ap1",
          toolKey: "Bash",
          expiresAt: "2026-10-27T06:00:00.000Z",
        },
        "run-gc1",
        "gc1",
      ),
    ];
    api(parentEvents(), undefined, {
      [`GET ${GRANDCHILD}/events`]: () => json(200, { events: waiting }),
    });
    window.history.replaceState(null, "", "/chat/c1?subagent=gc1");
    await renderChatRoute();
    const dialog = await gcDialog();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#agents=gc1/transcript");
    const log = await within(dialog).findByRole("log");
    await waitFor(() => expect(log.querySelector('[data-entry="approval"]')).not.toBeNull());
  });
});

describe("the sub-agent right panel's own sub-agents (final review)", () => {
  /** The child's log with its own `Agent` call that dispatched the grandchild. */
  const withGrandchild = (): ConversationEvent[] => {
    const c = (seq: number, type: string, payload: unknown) =>
      ev(seq, type, payload, "run-ch1", "ch1");
    return [
      ...childEvents(),
      c(9, "assistant_message", {
        step: 3,
        stopReason: "tool_use",
        content: [call("ka", "Read the changelog")],
      }),
      c(10, "subagent_dispatched", {
        step: 3,
        callId: "ka",
        subagentId: "gc1",
        childRunId: "run-gc1",
        agentType: "general-purpose",
        description: "Read the changelog",
        resumed: false,
        model: { provider: "model-fake", model: "fake-1" },
      }),
    ];
  };

  it("an Agent call in the panel's record opens that agent in the map", async () => {
    api(parentEvents(), undefined, {
      [`GET ${CHILD}/events`]: () => json(200, { events: withGrandchild() }),
    });
    window.history.replaceState(null, "", "/chat/c1#subagent=ch1");
    await renderChatRoute();
    // the record replaces the panel's loading state: read the panel again each time
    const block = await waitFor(() => {
      const panel = screen.getByRole("complementary", { name: "Scan docs" });
      const b = panel.querySelector('[data-part="agent-call-block"]');
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    await userEvent.setup().click(within(block).getByRole("button", { name: "View in agent map" }));
    expect(window.location.hash).toBe("#agents=gc1");
    expect(await screen.findByRole("dialog", { name: "Read the changelog" })).toBeTruthy();
  });
});

describe("the agent map's statuses and keys (final review)", () => {
  const c = (seq: number, type: string, payload: unknown, runId: string | null = "run-ch1") =>
    ev(seq, type, payload, runId, "ch1");

  it("a queued restart (a message after the end, no run yet) keeps the tree's status and Stop", async () => {
    const restarted = [
      ...childEvents().slice(0, 5),
      c(6, "run_finished", { reason: "completed", consumedUpToSeq: 2 }),
      c(
        7,
        "user_message",
        {
          content: [{ type: "text", text: "One more thing" }],
          authorAccountId: "a1",
          dispatch: {
            parentConversationId: "c1",
            parentRunId: "r1",
            callId: "s1",
            kind: "message",
          },
        },
        null,
      ),
    ];
    api(parentEvents(), () => json(200, tree("queued")), {
      [`GET ${CHILD}/events`]: () => json(200, { events: restarted }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    expect(await within(dialog).findByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("a run that ran out of steps reads as failed in the tree and at level 2, as in the stream", async () => {
    const ended = [
      ...childEvents().slice(0, 5),
      c(6, "run_finished", { reason: "max_steps", consumedUpToSeq: 2 }),
    ];
    api(
      [
        ...parentEvents(),
        ev(5, "subagent_finished", {
          subagentId: "ch1",
          childRunId: "run-ch1",
          callId: "k1",
          status: "max_steps",
          toolCalls: 1,
          durationMs: 4000,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ],
      () => json(200, tree("idle")),
      { [`GET ${CHILD}/events`]: () => json(200, { events: ended }) },
    );
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    const dialog = await mapDialog();
    const scan = await within(dialog).findByText("Scan docs");
    expect(
      scan
        .closest('[data-part="agent-node"]')
        ?.querySelector('[data-part="agent-dot"]')
        ?.getAttribute("data-status"),
    ).toBe("failed");
    await userEvent.setup().click(scan);
    const detail = await detailDialog();
    await waitFor(() =>
      expect(
        detail
          .querySelector('[data-part="agent-map-head"] [data-part="agent-dot"]')
          ?.getAttribute("data-status"),
      ).toBe("failed"),
    );
  });

  it("Esc at level 2 goes back to the tree; at the tree it closes the map", async () => {
    api(parentEvents());
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    await within(await detailDialog()).findByRole("button", { name: "Open transcript" });
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.hash).toBe("#agents"));
    expect(await within(await mapDialog()).findByText("Read the changelog")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("a background task's notice in a transcript opens the task", async () => {
    const withTask = [
      ...childEvents(),
      c(
        9,
        "background_task_finished",
        {
          taskId: "t1",
          description: "Build docs",
          status: "completed",
          exitCode: 0,
          elapsedMs: 3000,
          lastLines: "done",
          outputPath: "/workspace/.capybara/tasks/t1.log",
          reported: false,
        },
        null,
      ),
    ];
    api(parentEvents(), undefined, {
      [`GET ${CHILD}/events`]: () => json(200, { events: withTask }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1/transcript");
    await renderChatRoute();
    const log = await within(await detailDialog()).findByRole("log");
    const notice = await waitFor(() => {
      const n = log.querySelector('[data-entry="background"]');
      expect(n).not.toBeNull();
      return n as HTMLElement;
    });
    await userEvent.setup().click(within(notice).getByRole("button", { name: "Open" }));
    expect(window.location.hash).toBe("#bg-t1");
  });
});

describe("stopping a sub-agent from the map (AC5)", () => {
  const c = (seq: number, type: string, payload: unknown, runId: string | null = "run-ch1") =>
    ev(seq, type, payload, runId, "ch1");
  const ended = (reason = "completed") => [
    ...childEvents().slice(0, 5),
    c(6, "run_finished", { reason, consumedUpToSeq: 2 }),
  ];
  const abortCalls = (calls: Call[]) =>
    calls.filter((x) => x.method === "POST" && x.url === `${CHILD}/abort`).length;
  const toasts = () => [...document.querySelectorAll(".cb-toast-msg")].map((t) => t.textContent);
  const headStatus = (dialog: HTMLElement) =>
    dialog
      .querySelector('[data-part="agent-map-head"] [data-part="agent-dot"]')
      ?.getAttribute("data-status");

  it("Stop stays rendered, busy and disabled while the stop is pending, until the terminal event", async () => {
    let answer: (r: Response) => void = () => {};
    const calls = api(parentEvents(), undefined, {
      [`POST ${CHILD}/abort`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    const user = userEvent.setup();
    await user.click(await within(dialog).findByRole("button", { name: "Stop" }));
    const busy = await within(dialog).findByRole("button", { name: "Stop" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(true);
    await user.click(busy);
    expect(abortCalls(calls)).toBe(1);
    // the kernel took it: still stopping until the agent's terminal event arrives
    await act(async () => answer(json(202, { runId: "run-ch1" })));
    expect(within(dialog).getByRole("button", { name: "Stop" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    await waitFor(() => expect(childStream()).toBeTruthy());
    act(() => {
      childStream()?.emit(
        "event",
        ev(9, "run_aborted", { byAccountId: "a1", reason: "user" }, "run-ch1", "ch1"),
      );
    });
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull());
    expect(headStatus(dialog)).toBe("aborted");
  });

  it("a failed request shows one stop-specific toast, logs the browser's reason, and frees Stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = api(parentEvents(), undefined, {
      [`POST ${CHILD}/abort`]: () => {
        throw new TypeError("Load failed");
      },
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toBe(
      "Couldn't stop: Cannot reach the server. Check your network connection.",
    );
    expect(abortCalls(calls)).toBe(1);
    // the browser's own message goes to the console, not the UI
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[2])).toContain("Load failed");
    const stop = within(dialog).getByRole("button", { name: "Stop" });
    expect(stop.getAttribute("aria-busy")).toBeNull();
    expect(stop.hasAttribute("disabled")).toBe(false);
    warn.mockRestore();
  });

  it("409 run.not_active reads the tree, the child's row and its log again, and Stop goes", async () => {
    let logReads = 0;
    const calls = api(parentEvents(), undefined, {
      // the page holds a stale running log; the kernel's says the run ended
      [`GET ${CHILD}/events`]: () =>
        json(200, { events: logReads++ === 0 ? childEvents() : ended() }),
      [`POST ${CHILD}/abort`]: () =>
        json(409, { error: { code: "run.not_active", message: "no active run" } }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    const stop = await within(dialog).findByRole("button", { name: "Stop" });
    const before = {
      tree: treeReads(calls),
      row: calls.filter((x) => x.method === "GET" && x.url === CHILD).length,
    };
    await userEvent.setup().click(stop);
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull());
    expect(headStatus(dialog)).toBe("completed");
    expect(treeReads(calls)).toBeGreaterThan(before.tree);
    expect(calls.filter((x) => x.method === "GET" && x.url === CHILD).length).toBeGreaterThan(
      before.row,
    );
    expect(logReads).toBeGreaterThan(1);
    // the kernel's answer is no failure to report
    expect(toasts()).toHaveLength(0);
  });

  const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);
  // The head's status and Stop come from one status, settled from the log first: a tree read
  // before the run's end never brings Stop back (rows: the child's log tail, the tree's status).
  const restart = (seq: number): ConversationEvent =>
    c(
      seq,
      "user_message",
      {
        content: [{ type: "text", text: "One more thing" }],
        authorAccountId: "a1",
        dispatch: { parentConversationId: "c1", parentRunId: "r1", callId: "s1", kind: "message" },
      },
      null,
    );
  it.each([
    ["an open run, tree running", childEvents(), "running", "running"],
    ["an open run, tree idle (read before it started)", childEvents(), "idle", "running"],
    ["run finished, tree still running (stale)", ended(), "running", "completed"],
    [
      "run aborted, tree still running (stale)",
      [...childEvents(), c(9, "run_aborted", { byAccountId: "a1", reason: "user" })],
      "running",
      "aborted",
    ],
    ["run out of steps, tree still running", ended("max_steps"), "running", "failed"],
    ["a queued restart after the end, tree queued", [...ended(), restart(7)], "queued", "running"],
    ["a message after the end, tree idle", [...ended(), restart(7)], "idle", "completed"],
  ] as const)("%s: head %s", async (_, log, treeStatus, expected) => {
    api(parentEvents(), () => json(200, tree(treeStatus)), {
      [`GET ${CHILD}/events`]: () => json(200, { events: log }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents=ch1");
    await renderChatRoute();
    const dialog = await detailDialog();
    await within(dialog).findByText("Reading the docs first.");
    await waitFor(() => expect(headStatus(dialog)).toBe(expected));
    const active = ACTIVE_STATUSES.has(expected);
    await waitFor(() =>
      expect(within(dialog).queryByRole("button", { name: "Stop" }) !== null).toBe(active),
    );
    // settled: both still agree once every read has landed
    await act(async () => await new Promise((r) => setTimeout(r, 50)));
    expect(headStatus(dialog)).toBe(expected);
    expect(within(dialog).queryByRole("button", { name: "Stop" }) !== null).toBe(active);
  });

  it("a message after the end with a tree read before it: the tree is read again and Stop never shows", async () => {
    let reads = 0;
    // the map's first tree read predates the run's end (running); the kernel's next says idle
    const calls = api(parentEvents(), () => json(200, tree(reads++ === 0 ? "running" : "idle")), {
      [`GET ${CHILD}/events`]: () => json(200, { events: [...ended(), restart(7)] }),
    });
    window.history.replaceState(null, "", "/chat/c1#agents");
    await renderChatRoute();
    await userEvent.setup().click(await within(await mapDialog()).findByText("Scan docs"));
    const dialog = await detailDialog();
    await within(dialog).findByText("Reading the docs first.");
    await waitFor(() => expect(treeReads(calls)).toBeGreaterThan(1));
    await waitFor(() => expect(headStatus(dialog)).toBe("completed"));
    expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("liveStatus never takes an active tree word after the log's end, unless the tree is fresh", () => {
    const log = (events: ConversationEvent[]) => ({
      loading: false,
      running: false,
      waiting: false,
      events,
    });
    expect(liveStatus("running", logWord({ ...log([]), loading: true }), false)).toBe("running");
    expect(liveStatus("running", logWord(log(ended())), false)).toBe("completed");
    expect(liveStatus("running", logWord(log(ended())), true)).toBe("completed");
    const restarted = logWord(log([...ended(), restart(7)]));
    expect(restarted).toEqual({ kind: "restart", seq: 7, ended: "completed" });
    expect(liveStatus("running", restarted, false)).toBe("completed");
    expect(liveStatus("running", restarted, true)).toBe("running");
    expect(liveStatus("completed", logWord({ ...log([]), running: true }), false)).toBe("running");
    expect(liveStatus("running", logWord({ ...log([]), waiting: true }), false)).toBe("waiting");
  });
});
