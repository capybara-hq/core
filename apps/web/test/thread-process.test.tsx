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

  it("a running head times the run from run_started, not from its first row (#927)", async () => {
    const at = (e: ConversationEvent, s: number) => ({
      ...e,
      createdAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) + s * 1000).toISOString(),
    });
    api(
      [
        at(userMsg(1, "go"), 0),
        at(runStarted(2), 1),
        // the first model call thinks for 29 s before its first row
        at(step(3, 0, [bash("t1", "rm -rf build")]), 30),
        // the approval stops the run's clock: 39 s of work, whenever the page is read
        at(
          ev(4, "approval_requested", {
            step: 0,
            callId: "t1",
            approvalId: "ap1",
            toolKey: "Bash",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          40,
        ),
      ],
      {
        [`GET ${ORG}/approvals/ap1`]: () => json(404, { error: { code: "not_found" } }),
      },
    );
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    expect(block.getAttribute("data-state")).toBe("waiting");
    expect(block.querySelector('[data-part="process-time"]')?.textContent).toBe("39s");
  });

  it("a finished head shows the pinned badge its tool recorded, without reading the view (#928)", async () => {
    const view = vi.fn(() => json(200, { view: { badge: "9/9", blocks: [] } }));
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
          card: { plugin: "todo", view: "tasks-card", placement: "pinned", badge: "3/5" },
        }),
        step(5, 1, [{ type: "text", text: "Planned." }], "end_turn"),
        finished(6),
      ],
      {
        [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [TODO_CARD] }),
        [`GET ${ORG}/ui/views/todo/tasks-card`]: view,
      },
    );
    await renderChatRoute();
    await screen.findByText("Planned.");
    const head = within(theBlock()).getByRole("button", { name: /Worked/ });
    await vi.waitFor(() => expect(head.textContent).toContain("Todos 3/5"));
    expect(view).not.toHaveBeenCalled();
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
    // its result: the model plans the next step, so the head names none (the planning row
    // stands at the rail's end)
    act(() => es.emit("event", result(4, "t1")));
    expect(label()).toBe("Running");
    expect(block.querySelector('[data-part="rail-planning"]')).not.toBeNull();
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
    expect(label()).toBe("Running · Read the notes");
    // the live region keeps the announce interval: the visible label is hidden from it
    const announced = () =>
      (block.querySelector('[data-part="process-announce"]') as HTMLElement).textContent;
    expect(block.querySelector('[data-part="process-summary"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(announced()).toBe("Running · Bash cat no");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(announced()).toBe("Running · Read the notes");
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

  it("the rail is sectioned by todo item; a done item's section starts closed", async () => {
    const todo = (seq: number, s: number, id: string, text: string) => [
      step(seq, s, [{ type: "tool_call", id, name: "plugin__todo__write", input: {} }]),
      ev(seq + 1, "tool_result", {
        step: s,
        callId: id,
        toolKey: "plugin__todo__write",
        content: "ok",
        isError: false,
        card: { plugin: "todo", view: "tasks-card", placement: "pinned", key: id, text },
      }),
    ];
    api([
      userMsg(1, "plan it"),
      runStarted(2),
      ...todo(3, 0, "td1", "- [ ] **Reading the spec** (in progress)\n- [ ] Write the code"),
      step(5, 1, [bash("t1", "cat spec.md")]),
      result(6, "t1"),
      ...todo(7, 2, "td2", "- [x] Read the spec\n- [ ] **Writing the code** (in progress)"),
      step(9, 3, [bash("t2", "make")]),
      result(10, "t2"),
      step(11, 4, [{ type: "text", text: "Done." }], "end_turn"),
      finished(12),
    ]);
    await renderChatRoute();
    await screen.findByText("Done.");
    const block = theBlock();
    const user = userEvent.setup();
    await user.click(within(block).getByRole("button", { name: /Worked/ }));
    const sections = [...block.querySelectorAll<HTMLElement>('[data-part="rail-section"]')];
    expect(sections.map((x) => x.textContent)).toEqual([
      expect.stringContaining("Read the spec"),
      expect.stringContaining("Writing the code"),
    ]);
    // Read the spec is done: its section is closed, its steps hidden; the open item's steps show
    const [read, write] = sections.map((x) => within(x).getByRole("button"));
    expect(read?.getAttribute("aria-expanded")).toBe("false");
    expect(read?.textContent).toContain("2 steps");
    expect(write?.getAttribute("aria-expanded")).toBe("true");
    expect(within(block).queryByText("cat spec.md")).toBeNull();
    expect(within(block).getByText("make")).toBeTruthy();
    // the rail's ends: the first write (before any list) starts the rule, the last step ends it
    const rows = [...block.querySelectorAll<HTMLElement>("[data-edge]")];
    expect(rows.map((r) => r.getAttribute("data-edge"))).toEqual(["first", "mid", "mid", "last"]);
    if (read === undefined) throw new Error("no section");
    await user.click(read);
    expect(read.getAttribute("aria-expanded")).toBe("true");
    expect(within(block).getByText("cat spec.md")).toBeTruthy();
  });

  it("a long rail mounts only the rows near the viewport", async () => {
    const events: ConversationEvent[] = [userMsg(1, "go"), runStarted(2)];
    const n = 400;
    for (let i = 0; i < n; i++) {
      events.push(step(3 + 2 * i, i, [bash(`t${i}`, `echo ${i}`)]));
      events.push(result(4 + 2 * i, `t${i}`));
    }
    events.push(step(3 + 2 * n, n, [{ type: "text", text: "All done." }], "end_turn"));
    events.push(finished(4 + 2 * n));
    api(events);
    await renderChatRoute();
    await screen.findByText("All done.");
    const block = theBlock();
    await userEvent.setup().click(within(block).getByRole("button", { name: /Worked/ }));
    // no fold row: the whole rail is there, windowed
    expect(within(block).queryByRole("button", { name: /earlier step/ })).toBeNull();
    const mounted = railSteps(block).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(n);
    const list = block.querySelector('[data-part="rail-list"]') as HTMLElement;
    expect(list.getAttribute("data-virtual")).toBe("true");
    // the first row starts the rule; the rows not mounted are one spacer after them
    expect(railSteps(block)[0]?.getAttribute("data-edge")).toBe("first");
    const spacers = list.querySelectorAll('[data-part="rail-spacer"]');
    expect(spacers).toHaveLength(1);
    expect(list.lastElementChild?.getAttribute("data-part")).toBe("rail-spacer");
    expect(within(block).getByText("echo 0")).toBeTruthy();
    expect(within(block).queryByText(`echo ${n - 1}`)).toBeNull();
  });

  it("a device code stands outside while its call runs and folds into the rail once used", async () => {
    const head = [
      userMsg(1, "log in"),
      runStarted(2),
      step(3, 0, [bash("g", "gh auth login --web")]),
      ev(4, "device_code", { callId: "g", url: "https://github.com/login/device", code: "AB-12" }),
    ];
    api(head);
    await renderChatRoute();
    await vi.waitFor(() => expect(entries()).toEqual(["user", "process", "device-code"]));
    expect(screen.getByText("AB-12")).toBeTruthy();
    const es = FakeEventSource.instances.at(-1);
    if (es === undefined) throw new Error("no stream");
    act(() => es.emit("event", result(5, "g")));
    await vi.waitFor(() => expect(entries()).toEqual(["user", "process"]));
    const block = theBlock();
    const row = block.querySelector('[data-role="device-code"]') as HTMLElement;
    expect(row.getAttribute("data-state")).toBe("used");
    expect(row.textContent).toContain(en.chat.deviceCode.used);
    // the spent code is not shown again
    expect(screen.queryByText("AB-12")).toBeNull();
  });
});

// The live state (maintainer decision 2026-11-27, design spec §6.16.8a): spinners only in the head
// and on each of several concurrent rows; rail icons are always the step's kind.
describe("the live process block", () => {
  const described = (id: string, command: string, description: string) => ({
    type: "tool_call",
    id,
    name: "Bash",
    input: { command, description },
  });
  const started = (seq: number, callId: string) =>
    ev(seq, "tool_call_started", { step: 0, callId, toolKey: "Bash", specHash: "h" });

  it("a parallel command group: the head and each running row spin, the rail shows the terminal", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [
        described("t1", "pnpm why xlsx", "Check deps"),
        described("t2", "pnpm test", "Run tests"),
      ]),
      started(4, "t1"),
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    const spinners = block.querySelectorAll('[data-part="spinner"]');
    expect(spinners).toHaveLength(3);
    expect(block.querySelectorAll('[data-part="process-head"] [data-part="spinner"]')).toHaveLength(
      1,
    );
    expect(block.querySelectorAll('[data-part="tool-row"] [data-part="spinner"]')).toHaveLength(2);
    expect(block.querySelector('[data-part="rail-gutter"] [data-part="spinner"]')).toBeNull();
    expect(block.querySelector('[data-part="rail-gutter"] [data-icon="terminal"]')).not.toBeNull();
    expect(block.textContent).toContain("Running 2 commands · 0 done");
    // both rows show their time, the queued one too
    const ends = [...block.querySelectorAll('[data-part="tool-row"] .cb-tool-end')];
    expect(ends).toHaveLength(2);
    // the head names the first command by its description, and how many more run beside it
    const summary = block.querySelector('[data-part="process-summary"]') as HTMLElement;
    expect(summary.textContent).toBe("Running · Check deps and 1 more command");
    expect(summary.textContent).not.toContain("pnpm");
  });

  it("a single running command: the head reads its description, the line has no spinner", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [described("t1", "pnpm test --filter x", "Run the tests")]),
      started(4, "t1"),
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    expect((block.querySelector('[data-part="process-summary"]') as HTMLElement).textContent).toBe(
      "Running · Run the tests",
    );
    expect(block.querySelectorAll('[data-part="spinner"]')).toHaveLength(1);
  });

  it("live thinking: one spinner (the head), the lightbulb, then the collapsed thought", async () => {
    api([userMsg(1, "go"), runStarted(2)]);
    await renderChatRoute();
    // the block stands before the first step: thinking takes the planning row's place in it
    const planned = await vi.waitFor(theBlock);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    act(() => {
      es.emit("delta", {
        runId: "r1",
        step: 0,
        delta: "thinking",
        text: "**Status**: read `a.md` first.",
        offset: 0,
      });
    });
    act(() => {
      for (const f of frames.splice(0)) f(0);
    });
    const block = theBlock();
    expect(block).toBe(planned);
    expect(block.querySelector('[data-part="rail-planning"]')).toBeNull();
    expect(block.querySelectorAll('[data-part="spinner"]')).toHaveLength(1);
    expect(block.querySelector('[data-part="process-head"] [data-part="spinner"]')).not.toBeNull();
    const gutter = block.querySelector('[data-part="rail-gutter"]') as HTMLElement;
    expect(gutter.querySelector('[data-icon="lightbulb"]')).not.toBeNull();
    const tail = await vi.waitFor(() => {
      const t = block.querySelector('[data-part="thinking-tail"]');
      if (t === null) throw new Error("no tail");
      return t as HTMLElement;
    });
    expect(tail.querySelector("strong")?.textContent).toBe("Status");
    expect(tail.textContent).not.toContain("**");
    act(() =>
      es.emit(
        "event",
        step(3, 0, [
          { type: "thinking", text: "**Status**: read `a.md` first." },
          bash("t1", "ls"),
        ]),
      ),
    );
    await vi.waitFor(() => {
      if (block.querySelector('[data-part="thinking-tail"]') !== null)
        throw new Error("still live");
    });
    const line = within(block).getByRole("button", { name: /Thought/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(line);
    const body = block.querySelector('[data-part="thinking-body"]') as HTMLElement;
    expect(body.querySelector("code")?.textContent).toBe("a.md");
  });

  it("a finished command shows its exit code on the row only when it is not zero", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [described("t1", "true", "Pass"), described("t2", "false", "Fail")]),
      result(4, "t1", {
        view: { kind: "command", exitCode: 0, timedOut: false, description: "Pass" },
        display: {
          summary: { zh: "运行命令（退出码 0）：true", en: "Ran command (exit 0): true" },
        },
      }),
      result(5, "t2", {
        callId: "t2",
        view: { kind: "command", exitCode: 3, timedOut: false, description: "Fail" },
        display: {
          summary: { zh: "运行命令（退出码 3）：false", en: "Ran command (exit 3): false" },
        },
      }),
      finished(6),
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    await userEvent.click(within(block).getAllByRole("button")[0] as HTMLElement);
    await userEvent.click(within(block).getByRole("button", { name: /Ran 2 commands/ }));
    const rows = [...block.querySelectorAll<HTMLElement>('[data-part="tool-row"]')];
    expect(
      rows.map((r) => r.querySelector('[data-part="exit-code"]')?.textContent ?? null),
    ).toEqual([null, " · exit 3"]);
    expect(block.textContent).not.toContain("Ran command (exit");
  });

  it("narration renders its Markdown: inline code and bold, no raw marks", async () => {
    api([
      userMsg(1, "go"),
      runStarted(2),
      step(3, 0, [{ type: "text", text: "core `29e091ba1` is **released**" }, bash("t1", "ls")]),
      result(4, "t1"),
      finished(5),
    ]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    await userEvent.click(within(block).getAllByRole("button")[0] as HTMLElement);
    const say = block.querySelector('[data-part="rail-text"]') as HTMLElement;
    expect(say.querySelector("code")?.textContent).toBe("29e091ba1");
    expect(say.querySelector("strong")?.textContent).toBe("released");
    expect(say.textContent).not.toMatch(/[`*]/);
  });

  it("before the first step the block stands with the planning row as its last row", async () => {
    api([userMsg(1, "go"), runStarted(2)]);
    await renderChatRoute();
    const block = await vi.waitFor(theBlock);
    const list = block.querySelector('[data-part="rail-list"]') as HTMLElement;
    expect(list.lastElementChild?.getAttribute("data-part")).toBe("rail-planning");
    expect(list.lastElementChild?.getAttribute("data-edge")).toBe("only");
    expect(document.querySelector('[data-part="working-line"]')).toBeNull();
    expect((block.querySelector('[data-part="process-summary"]') as HTMLElement).textContent).toBe(
      "Running",
    );
  });
});
