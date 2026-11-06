import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { agentTreeNodes } from "../src/components/conversation/AgentMap";
import type { AgentTreeNode, ConversationEvent } from "../src/lib/conversations";
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

function api(
  events: ConversationEvent[],
  answer: () => Response = () => json(200, tree("running")),
): Call[] {
  return stubApi({
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
    await waitFor(() => expect(treeReads(calls)).toBeGreaterThan(before));
  });
});
