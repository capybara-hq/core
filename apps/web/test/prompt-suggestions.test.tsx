import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
  LIMITS,
  MODELS,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

/**
 * Prompt suggestions on the conversation page (prompt suggestions spec §4 and §5): the SSE
 * `event: suggestion` frame becomes the composer's placeholder only while the reader's rule holds
 * (its run is the latest finished one, nothing newer in the log, no run going), a dismissal sticks
 * for that run, and sub-agent composers never show one.
 */

const params = { conversationId: "c1" };
const search = new URLSearchParams();
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useSearchParams: () => search,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;
const TEXT = "Export the summary table as CSV";

function api(
  events: ConversationEvent[],
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/events`]: () => json(200, { events }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
    ...extra,
  });
}

const runFinished = (seq: number, runId = "r1") =>
  ev(seq, "run_finished", { reason: "completed", consumedUpToSeq: 1 }, runId);
const assistant = (seq: number, text: string, runId = "r1") =>
  ev(seq, "assistant_message", { step: 1, content: [{ type: "text", text }] }, runId);
/** A finished first run: its `run_finished` is seq 4. */
const FINISHED = [userMsg(1, "hi"), runStarted(2), assistant(3, "hello"), runFinished(4)];

const input = () =>
  screen.getByRole("textbox", { name: en.chat.inputLabel, hidden: true }) as HTMLTextAreaElement;
const placeholder = () => input().getAttribute("placeholder");
const es = () => FakeEventSource.instances.at(-1) as FakeEventSource;
const suggest = (runId: string, afterSeq: number, text = TEXT) =>
  act(() => es().emit("suggestion", { runId, afterSeq, text }));
const push = (e: ConversationEvent) => act(() => es().emit("event", e));

async function open(events: ConversationEvent[]) {
  api(events);
  await renderChatRoute();
  await screen.findByText("hi");
  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
}

beforeEach(() => {
  params.conversationId = "c1";
  for (const k of [...search.keys()]) search.delete(k);
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("prompt suggestions in the composer", () => {
  it("a suggestion frame for the latest finished run shows as the placeholder; Tab fills it", async () => {
    await open(FINISHED);
    expect(placeholder()).toBe(en.chat.placeholder);
    suggest("r1", 4);
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
    const user = userEvent.setup();
    await user.click(input());
    await user.keyboard("{Tab}");
    expect(input().value).toBe(TEXT);
  });

  it.each([
    ["user_message", userMsg(5, "next")],
    ["run_started", runStarted(5, "r2")],
  ])("a later %s hides it", async (_name, later) => {
    await open(FINISHED);
    suggest("r1", 4);
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
    push(later);
    await vi.waitFor(() => expect(placeholder()).not.toBe(TEXT));
  });

  it("a frame for an older run is ignored, also after a newer one showed", async () => {
    await open([
      ...FINISHED,
      userMsg(5, "more"),
      runStarted(6, "r2"),
      assistant(7, "sure", "r2"),
      runFinished(8, "r2"),
    ]);
    suggest("r1", 4);
    // nothing to wait for: the frame changes nothing
    await act(async () => {});
    expect(placeholder()).toBe(en.chat.placeholder);
    suggest("r2", 8, "Newer");
    await vi.waitFor(() => expect(placeholder()).toBe("Newer"));
    suggest("r1", 4);
    await act(async () => {});
    expect(placeholder()).toBe("Newer");
  });

  it("a running run hides it: a frame before the run's end shows once the end arrives", async () => {
    await open([userMsg(1, "hi"), runStarted(2), assistant(3, "hello")]);
    suggest("r1", 4);
    await act(async () => {});
    expect(placeholder()).not.toBe(TEXT);
    push(runFinished(4));
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
  });

  it("a dismissal sticks for that run: Esc, then the same frame again (a reopen)", async () => {
    await open(FINISHED);
    suggest("r1", 4);
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
    const user = userEvent.setup();
    await user.click(input());
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(placeholder()).toBe(en.chat.placeholder));
    suggest("r1", 4);
    await act(async () => {});
    expect(placeholder()).toBe(en.chat.placeholder);
  });

  it("typing then clearing the draft does not bring it back", async () => {
    await open(FINISHED);
    suggest("r1", 4);
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
    const user = userEvent.setup();
    await user.type(input(), "x");
    await user.clear(input());
    expect(placeholder()).toBe(en.chat.placeholder);
  });

  it("a file dropped on the composer dismisses it", async () => {
    api(FINISHED, {
      [`POST ${ORG}/attachments`]: () =>
        json(500, { error: { code: "internal", message: "nope" } }),
    });
    const { container } = await renderChatRoute();
    await screen.findByText("hi");
    suggest("r1", 4);
    await vi.waitFor(() => expect(placeholder()).toBe(TEXT));
    const zone = container.querySelector(".cb-file-drop") as HTMLElement;
    const f = new File([new Uint8Array(4)], "chart.png", { type: "image/png" });
    const transfer = {
      files: [f],
      types: ["Files"],
      getData: () => "",
      items: [{ kind: "file", type: f.type, getAsFile: () => f }],
    };
    fireEvent.dragEnter(zone, { dataTransfer: transfer });
    fireEvent.drop(zone, { dataTransfer: transfer });
    await vi.waitFor(() => expect(placeholder()).toBe(en.chat.placeholder));
  });

  it("a sub-agent's composer never shows one", async () => {
    api(FINISHED, { [`GET ${BASE}`]: () => json(200, CONV("c1", { parentConversationId: "p1" })) });
    await renderChatRoute();
    await screen.findByText("hi");
    suggest("r1", 4);
    await act(async () => {});
    expect(screen.queryByRole("textbox", { name: en.chat.inputLabel, hidden: true })).toBeTruthy();
    expect(placeholder()).not.toBe(TEXT);
  });
});
