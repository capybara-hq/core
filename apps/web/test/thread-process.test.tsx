import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { navigateBrowser } from "../src/lib/browser";
import { orgIconUrl } from "../src/lib/catalog";
import type { ConversationEvent } from "../src/lib/conversations";
import { bodyOf, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

// The thread draws a run as one process block (conversation process blocks spec §1.3, §4, §7):
// the page renders from the query cache (`renderChatRoute`), the log is the stubbed events.

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;

const BASH_INFO = {
  key: "Bash",
  title: null,
  kind: "command",
  icon: { kind: "name", name: "terminal" },
  sandbox: true,
  keyArgs: ["command"],
  tool: null,
  source: { kind: "builtin" },
};

const TODO_CARD = {
  plugin: "todo",
  id: "tasks-card",
  title: { zh: "待办", en: "Todos" },
  slot: "conversation.tool-result.card",
  kind: "view",
  icon: "list-checks",
};

function api(
  events: ConversationEvent[],
  extra: Record<string, () => Response> = {},
  tools: unknown[] = [BASH_INFO],
) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/events`]: () => json(200, { events }),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${BASE}/tools`]: () => json(200, { tools }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${ORG}/attachments/limits`]: () => json(200, LIMITS),
    ...extra,
  });
}

/** One model step: thinking, narration and tool calls (narration needs a call beside it). */
const step = (
  seq: number,
  s: number,
  content: unknown[],
  stopReason: "tool_use" | "end_turn" = "tool_use",
) => ev(seq, "assistant_message", { step: s, stopReason, content });
const bash = (id: string, command: string) => ({
  type: "tool_call",
  id,
  name: "Bash",
  input: { command },
});
const result = (seq: number, callId: string, extra: Record<string, unknown> = {}) =>
  ev(seq, "tool_result", {
    step: 0,
    callId,
    toolKey: "Bash",
    content: "ok",
    isError: false,
    ...extra,
  });
const finished = (seq: number) =>
  ev(seq, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 });

const entries = () =>
  [...document.querySelectorAll<HTMLElement>("[data-entry]")].map((e) =>
    e.getAttribute("data-entry"),
  );
const processEntries = () =>
  [...document.querySelectorAll<HTMLElement>('[data-entry="process"]')] as HTMLElement[];
const theBlock = () => {
  const [b] = processEntries();
  if (b === undefined) throw new Error("no process block");
  return b;
};
const railSteps = (b: HTMLElement) => b.querySelectorAll('[data-part="rail-step"]');

beforeEach(() => {
  vi.mocked(navigateBrowser).mockReset();
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("the thread draws process blocks", () => {
  it("finished run renders one collapsed block, files and the answer", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [
        { type: "thinking", text: "Plan the listing." },
        { type: "text", text: "Let me look at the folder." },
        bash("t1", "ls"),
      ]),
      result(4, "t1"),
      ev(5, "artifact_created", {
        artifactId: "f1",
        name: "out.csv",
        contentType: "text/csv",
        size: 9,
        sourcePath: "/w/out.csv",
        callId: "t1",
      }),
      step(6, 1, [{ type: "text", text: "All done." }], "end_turn"),
      finished(7),
    ]);
    await renderChatRoute();
    await screen.findByText("All done.");
    // block → files → answer → run row, one block for the whole run
    expect(entries()).toEqual(["user", "process", "files", "prose", "run"]);
    const block = theBlock();
    expect(block.getAttribute("data-state")).toBe("finished");
    const head = within(block).getByRole("button", { name: /Worked/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // collapsed: the head counts the work, the rail is not drawn
    expect(head.textContent).toContain("Thought once");
    expect(head.textContent).toContain("1 tool");
    expect(block.querySelector('[data-part="process-rail"]')).toBeNull();
    expect(screen.queryByText("Let me look at the folder.")).toBeNull();
    expect(screen.getByRole("button", { name: /out\.csv/ })).toBeTruthy();
    // opening it shows every step: the thinking, the narration, the call
    await userEvent.setup().click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(railSteps(block)).toHaveLength(3);
    expect(within(block).getByText("Let me look at the folder.")).toBeTruthy();
    expect(within(block).getByText("Bash")).toBeTruthy();
  });

  it("running block shows the last four steps and the fold row", async () => {
    const events: ConversationEvent[] = [userMsg(1, "go"), runStarted(2)];
    for (let i = 0; i < 6; i++) {
      events.push(step(3 + 2 * i, i, [bash(`t${i}`, `echo ${i}`)]));
      events.push(result(4 + 2 * i, `t${i}`));
    }
    api(events);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    expect(block.getAttribute("data-state")).toBe("running");
    expect(railSteps(block)).toHaveLength(4);
    expect(within(block).queryByText("echo 0")).toBeNull();
    expect(within(block).getByText("echo 5")).toBeTruthy();
    const fold = within(block).getByRole("button", { name: "2 earlier steps" });
    await userEvent.setup().click(fold);
    expect(railSteps(block)).toHaveLength(6);
    expect(within(block).getByText("echo 0")).toBeTruthy();
  });

  it("pending actions link to the handoff target", async () => {
    api(
      [
        userMsg(1, "set up the channel"),
        runStarted(2),
        step(3, 0, [{ type: "tool_call", id: "p1", name: "Platform", input: { action: "x" } }]),
        ev(4, "tool_result", {
          step: 0,
          callId: "p1",
          toolKey: "Platform",
          content: "ok",
          isError: false,
          view: {
            kind: "handoff",
            title: { zh: "设置发布渠道", en: "Set up the channel" },
            target: { type: "link", url: "/settings/channels" },
          },
        }),
        step(5, 1, [{ type: "text", text: "One thing for you." }], "end_turn"),
        finished(6),
      ],
      {},
      [],
    );
    await renderChatRoute();
    await screen.findByText("One thing for you.");
    expect(entries()).toEqual(["user", "process", "pending", "prose", "run"]);
    const pending = document.querySelector('[data-entry="pending"]') as HTMLElement;
    expect(within(pending).getByText("Set up the channel")).toBeTruthy();
    const link = within(pending).getByRole("link", { name: en.chat.handoff.open });
    expect(link.getAttribute("href")).toBe("/settings/channels");
  });

  it("connect target starts the connect flow", async () => {
    const AUTH_URL = "https://auth.example.com/authorize?state=s1";
    const calls = api(
      [
        userMsg(1, "connect my docs"),
        runStarted(2),
        step(3, 0, [{ type: "tool_call", id: "p1", name: "Platform", input: { action: "x" } }]),
        ev(4, "tool_result", {
          step: 0,
          callId: "p1",
          toolKey: "Platform",
          content: "ok",
          isError: false,
          view: {
            kind: "handoff",
            title: { zh: "连接文档", en: "Connect Docs" },
            target: { type: "connect", connectorId: "app1" },
          },
        }),
        step(5, 1, [{ type: "text", text: "Connect it when you can." }], "end_turn"),
        finished(6),
      ],
      {
        [`GET ${ORG}/connectors/app1`]: () =>
          json(200, { connector: { id: "app1", name: "Docs", auth: { type: "oauth_code" } } }),
        [`POST ${ORG}/connectors/app1/connect`]: () => json(200, { authorizationUrl: AUTH_URL }),
      },
      [],
    );
    await renderChatRoute();
    const pending = await vi.waitFor(() => {
      const el = document.querySelector('[data-entry="pending"]');
      if (el === null) throw new Error("no pending entry");
      return el as HTMLElement;
    });
    expect(within(pending).getByText("Connect Docs")).toBeTruthy();
    // a connection starts here, not on another page
    expect(within(pending).queryByRole("link")).toBeNull();
    await userEvent
      .setup()
      .click(within(pending).getByRole("button", { name: en.chat.handoff.connect }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTH_URL));
    // the authorization comes back to this conversation
    const post = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/connectors/app1/connect"),
    );
    expect(bodyOf(post)).toEqual({ returnTo: "/chat/c1" });
  });

  it("parallel calls of one step are one rail step", async () => {
    api([
      userMsg(1, "look around"),
      runStarted(2),
      // one model step calls two tools at once, the next step one more
      step(3, 0, [bash("a", "ls src"), bash("b", "ls docs")]),
      result(4, "a"),
      result(5, "b"),
      step(6, 1, [bash("c", "cat notes.md")]),
      result(7, "c"),
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    // two rail steps: the burst as one tool group, then the single call
    const steps = railSteps(block);
    expect(steps).toHaveLength(2);
    const [burst, single] = [...steps] as HTMLElement[];
    expect(burst?.querySelector('[data-single="true"]')).toBeNull();
    expect(single?.querySelector('[data-single="true"]')).not.toBeNull();
    expect(within(single as HTMLElement).getByText("cat notes.md")).toBeTruthy();
    // the head still counts every call
    expect(block.getAttribute("data-tool-keys")).toBe("Bash Bash Bash");
  });

  it("pinned todo card renders under the head while running", async () => {
    api(
      [
        userMsg(1, "plan it"),
        runStarted(2),
        step(3, 0, [{ type: "tool_call", id: "td", name: "plugin__todo__write", input: {} }]),
        ev(4, "tool_result", {
          step: 0,
          callId: "td",
          toolKey: "plugin__todo__write",
          content: "ok",
          isError: false,
          card: { plugin: "todo", view: "tasks-card", placement: "pinned" },
        }),
        step(5, 1, [bash("t1", "make")]),
      ],
      {
        [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [TODO_CARD] }),
        [`GET ${ORG}/ui/views/todo/tasks-card`]: () =>
          json(200, {
            view: {
              badge: "1/2",
              blocks: [
                {
                  type: "checklist",
                  items: [
                    { text: "Read the spec", status: "completed" },
                    { text: "Write the code", status: "pending" },
                  ],
                },
              ],
            },
          }),
      },
    );
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    expect(block.getAttribute("data-state")).toBe("running");
    const pinned = block.querySelector('[data-part="process-pinned"]') as HTMLElement;
    expect(pinned).not.toBeNull();
    expect(pinned.querySelector('[data-extension-card="todo/tasks-card"]')).not.toBeNull();
    expect(await within(pinned).findByText("Write the code")).toBeTruthy();
    // the pinned card stands under the head, above the rail
    const rail = block.querySelector('[data-part="process-rail"]') as HTMLElement;
    expect(pinned.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and nowhere else in the thread
    expect(document.querySelectorAll('[data-extension-card="todo/tasks-card"]')).toHaveLength(1);
  });

  it("chips use the catalog icon of an extension tool", async () => {
    api(
      [
        userMsg(1, "remember this"),
        runStarted(2),
        step(3, 0, [
          { type: "tool_call", id: "m1", name: "plugin__memory__save", input: { text: "x" } },
        ]),
        ev(4, "tool_result", {
          step: 0,
          callId: "m1",
          toolKey: "plugin__memory__save",
          content: "ok",
          isError: false,
        }),
        step(5, 1, [{ type: "text", text: "Saved." }], "end_turn"),
        finished(6),
      ],
      {},
      [
        {
          key: "plugin__memory__save",
          title: "Save a memory",
          kind: "tool",
          icon: { kind: "catalog", itemId: "memory" },
          sandbox: false,
          keyArgs: ["text"],
          tool: "save",
          source: { kind: "extension", name: "memory", displayName: { zh: "记忆", en: "Memory" } },
        },
      ],
    );
    await renderChatRoute();
    await screen.findByText("Saved.");
    const chips = theBlock().querySelectorAll('[data-part="process-chip"]');
    expect(chips).toHaveLength(1);
    const chip = chips[0] as HTMLElement;
    expect(chip.getAttribute("aria-label")).toBe("Memory");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(orgIconUrl("o1", "memory"));
  });

  it("copying the answer copies no process text", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [{ type: "text", text: "Checking the files first." }, bash("t1", "ls")]),
      result(4, "t1"),
      step(5, 1, [{ type: "text", text: "Two files." }], "end_turn"),
      finished(6),
    ]);
    await renderChatRoute();
    await screen.findByText("Two files.");
    await userEvent.setup().click(within(theBlock()).getByRole("button", { name: /Worked/ }));
    expect(within(theBlock()).getByText("Checking the files first.")).toBeTruthy();
    // the answer is the only assistant message part; the narration is not inside it
    const answers = document.querySelectorAll('[data-cap-part="message.assistant"]');
    expect(answers).toHaveLength(1);
    expect((answers[0] as HTMLElement).textContent).toBe("Two files.");
    const prose = document.querySelector('[data-entry="prose"]') as HTMLElement;
    expect(prose.textContent).not.toContain("Checking the files first.");
    expect(prose.contains(theBlock())).toBe(false);
  });

  it("a streamed call is a rail step of the open block; the logged call takes it over in place", async () => {
    // streaming tool input spec D8 inside a process block: the streaming row stands where the
    // logged call lands (same block, same rail step), and logging it remounts nothing
    api([userMsg(1, "go"), runStarted(2), step(3, 0, [bash("t1", "ls")]), result(4, "t1")]);
    await renderChatRoute();
    await vi.waitFor(theBlock);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flush = () =>
      act(() => {
        for (const f of frames.splice(0)) f(0);
      });
    act(() => {
      es.emit("delta", {
        runId: "r1",
        step: 1,
        delta: "text",
        text: "Next, the notes.",
        offset: 0,
      });
    });
    flush();
    // the step's text streams as prose below the block until its call starts
    expect(entries()).toEqual(["user", "process", "prose"]);
    act(() => {
      es.emit("delta", { runId: "r1", step: 1, delta: "tool_start", callId: "t2", name: "Bash" });
      es.emit("delta", {
        runId: "r1",
        step: 1,
        delta: "tool_input",
        callId: "t2",
        text: '{"command":"cat no',
        offset: 0,
      });
    });
    flush();
    // the call started: the text is narration in the block, the call a streaming rail step
    expect(entries()).toEqual(["user", "process"]);
    const block = theBlock();
    expect(block.getAttribute("data-tool-status")).toBe("done streaming");
    const streamingStep = block.querySelector('[data-tool-step-status="streaming"]');
    expect(streamingStep).not.toBeNull();
    const railStep = streamingStep?.closest('[data-part="rail-step"]') as HTMLElement;
    expect(within(railStep).getByText("cat no")).toBeTruthy();
    expect(within(block).getByText("Next, the notes.")).toBeTruthy();

    act(() =>
      es.emit(
        "event",
        step(5, 1, [{ type: "text", text: "Next, the notes." }, bash("t2", "cat notes.md")]),
      ),
    );
    // the same block and the same rail step, now the logged call
    expect(entries()).toEqual(["user", "process"]);
    expect(theBlock()).toBe(block);
    expect(block.querySelector('[data-tool-step-status="streaming"]')).toBeNull();
    expect(within(railStep).getByText("cat notes.md")).toBeTruthy();
    expect(railStep.isConnected).toBe(true);
    expect(railSteps(block)[railSteps(block).length - 1]).toBe(railStep);
    expect(
      railStep.querySelector("[data-tool-step-status]")?.getAttribute("data-tool-step-status"),
    ).toBe("pending");
  });

  it("the head announces step changes, not rows", async () => {
    api([userMsg(1, "go"), runStarted(2), step(3, 0, [bash("t1", "ls")])]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    // the rail is not announced: only the head is a live region
    expect(block.getAttribute("aria-live")).toBe("off");
    const head = block.querySelector('[data-part="process-head"]') as HTMLElement;
    expect(head.getAttribute("aria-live")).toBe("polite");
    const label = () =>
      (head.querySelector('[data-part="process-summary"]') as HTMLElement).textContent;
    expect(label()).toBe("Running · Bash ls");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    // a row changing (its result) is no new step: the head says the same
    act(() => es.emit("event", result(4, "t1")));
    expect(label()).toBe("Running · Bash ls");
    // a new step changes it: the first change at once, later ones at most every few seconds
    act(() => es.emit("event", step(5, 1, [bash("t2", "cat notes.md")])));
    expect(label()).toBe("Running · Bash cat notes.md");
    act(() => es.emit("event", result(6, "t2")));
    act(() => es.emit("event", step(7, 2, [bash("t3", "pwd")])));
    expect(label()).toBe("Running · Bash cat notes.md");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(label()).toBe("Running · Bash pwd");
  });

  it("the head follows a streaming call's label within a moment, as its row does (B3)", async () => {
    api([userMsg(1, "go"), runStarted(2), step(3, 0, [bash("t1", "ls")]), result(4, "t1")], {}, [
      {
        ...BASH_INFO,
        inputView: { kind: "command", command: "command", description: "description" },
      },
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flush = () =>
      act(() => {
        for (const f of frames.splice(0)) f(0);
      });
    const label = () =>
      (block.querySelector('[data-part="process-summary"]') as HTMLElement).textContent;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const input = (text: string, offset: number) =>
      act(() => {
        es.emit("delta", { runId: "r1", step: 1, delta: "tool_input", callId: "t2", text, offset });
      });
    act(() => {
      es.emit("delta", { runId: "r1", step: 1, delta: "tool_start", callId: "t2", name: "Bash" });
    });
    const a = '{"command":"cat no';
    input(a, 0);
    flush();
    expect(label()).toBe("Running · Bash cat no");
    const b = 'tes.md","description":"Read the notes"}';
    input(b, a.length);
    flush();
    // not held for the announce interval: the description shows as the row's does
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(label()).toBe("Running · Bash Read the notes");
  });

  it("a run that ends without an answer shows its last narration as the answer", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [{ type: "text", text: "Cleaned up the folder." }, bash("t1", "rm tmp")]),
      result(4, "t1"),
      step(5, 1, [], "end_turn"),
      finished(6),
    ]);
    await renderChatRoute();
    await vi.waitFor(theBlock);
    await vi.waitFor(() => expect(entries()).toEqual(["user", "process", "prose", "run"]));
    const prose = document.querySelector('[data-entry="prose"]') as HTMLElement;
    expect(within(prose).getByText("Cleaned up the folder.")).toBeTruthy();
    expect(prose.contains(theBlock())).toBe(false);
  });

  it("a connect card keeps its Connect while the run goes on past the answer", async () => {
    api([
      userMsg(1, "read my docs"),
      runStarted(2),
      step(3, 0, [{ type: "tool_call", id: "c9", name: "mcp__docs__read", input: {} }]),
      ev(4, "connection_required", { callId: "c9", appId: "app1", appName: "Docs" }),
      ev(5, "tool_result", {
        step: 0,
        callId: "c9",
        toolKey: "mcp__docs__read",
        content: "not connected",
        isError: true,
      }),
    ]);
    await renderChatRoute();
    const button = () =>
      within(document.querySelector('[data-role="connect"]') as HTMLElement).getByRole("button", {
        name: "Connect",
      });
    const before = await vi.waitFor(button);
    // the answer arrives; the run has not ended: the same button stays, outside the block
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() =>
      es.emit("event", step(6, 1, [{ type: "text", text: "Please connect Docs." }], "end_turn")),
    );
    await screen.findByText("Please connect Docs.");
    expect(button()).toBe(before);
    expect(theBlock().contains(before)).toBe(false);
    expect(entries()).toEqual(["user", "process", "connect", "prose"]);
    // the run ends: the card folds into the block and offers Connect no more
    act(() => es.emit("event", finished(7)));
    await vi.waitFor(() => expect(entries()).toEqual(["user", "process", "prose", "run"]));
  });
});
