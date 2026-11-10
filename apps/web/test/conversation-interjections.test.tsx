import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { json, stubApi } from "./support/api";
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
 * Run input spec D4 on the page: a message sent while a run goes stands where the model took it
 * in; until then it is a pending bubble (the queued look, 待处理) at the bottom.
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

const BASE = "/api/v1/orgs/o1/conversations/c1";

function api(events: unknown[]) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
    "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
    [`GET ${BASE}/events`]: () => json(200, { events }),
  });
}

const reply = (seq: number, text: string) =>
  ev(seq, "assistant_message", {
    step: 1,
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  });
const modelCall = (seq: number, absorbedUpToSeq: number) =>
  ev(seq, "model_call", {
    step: 1,
    provider: "model-fake",
    model: "fake-1",
    request: { absorbedUpToSeq },
  });

/** The thread's entries in order: their kind, a bubble's text. */
const order = () =>
  [...document.querySelectorAll("[data-entry]")].map((e) => {
    const kind = e.getAttribute("data-entry");
    return kind === "user" ? `user:${e.querySelector('[data-part="bubble"]')?.textContent}` : kind;
  });

beforeEach(() => {
  params.conversationId = "c1";
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("interjections on the conversation page (spec D4)", () => {
  it("a message the streaming step never saw is a pending bubble below its reply", async () => {
    api([
      userMsg(1, "Can you understand yourself?"),
      runStarted(2),
      modelCall(3, 1),
      userMsg(4, "haha"),
      reply(5, "I can."),
    ]);
    await renderChatRoute();
    await screen.findByText("I can.");
    expect(order()).toEqual(["user:Can you understand yourself?", "prose", "user:haha"]);
    // the public part hooks of the thread (client extensions spec §7.1)
    expect(
      screen.getByText("I can.").closest('[data-cap-part="message.assistant"]'),
    ).not.toBeNull();
    expect(screen.getByText("haha").closest('[data-cap-part="message.user"]')).not.toBeNull();
    const pending = screen.getByText("haha").closest('[data-part="bubble"]') as HTMLElement;
    expect(pending.getAttribute("data-queued")).toBe("true");
    const entry = pending.closest("[data-entry]") as HTMLElement;
    expect(entry.textContent).toContain(en.chat.interjectionPending);
    expect(zh.chat.interjectionPending).toBe("待处理");
    // the asked message is an ordinary bubble
    const asked = screen.getByText("Can you understand yourself?").closest('[data-part="bubble"]');
    expect(asked?.getAttribute("data-queued")).toBeNull();
  });

  it("once its run ended it stands after the run row, an ordinary bubble", async () => {
    api([
      userMsg(1, "Can you understand yourself?"),
      runStarted(2),
      modelCall(3, 1),
      userMsg(4, "haha"),
      reply(5, "I can."),
      ev(6, "run_finished", { consumedUpToSeq: 1 }),
    ]);
    await renderChatRoute();
    await screen.findByText("I can.");
    await vi.waitFor(() =>
      expect(order()).toEqual(["user:Can you understand yourself?", "prose", "run", "user:haha"]),
    );
    const bubble = screen.getByText("haha").closest('[data-part="bubble"]');
    expect(bubble?.getAttribute("data-queued")).toBeNull();
    expect(document.body.textContent).not.toContain(en.chat.interjectionPending);
  });
});
