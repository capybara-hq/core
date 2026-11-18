import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { json, stubApi } from "./support/api";
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
 * Inline image progress (spec 2026-11-18): while a GenerateImage call runs, the thread draws one
 * placeholder per requested image, and each delivered image takes its placeholder's place in the
 * same files stack; a failed call removes them.
 */

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => ({ conversationId: "c1" }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const CONVERSATION = `${ORG}/conversations/c1`;
const GENERATING = /Generating image/;

const events = (): ConversationEvent[] => [
  userMsg(1, "draw"),
  runStarted(2),
  ev(3, "assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "g1",
        name: "GenerateImage",
        input: { prompt: "p", n: 2, aspect_ratio: "3:4" },
      },
    ],
  }),
  ev(4, "tool_call_started", { step: 1, callId: "g1", toolKey: "GenerateImage", specHash: "h" }),
];

const image = (seq: number, id: string) =>
  ev(seq, "artifact_created", {
    artifactId: id,
    name: `${id}.png`,
    contentType: "image/png",
    size: 2048,
    sourcePath: `/w/${id}.png`,
    callId: "g1",
  });

function api() {
  stubApi({
    [`GET ${CONVERSATION}`]: () => json(200, CONV("c1")),
    [`GET ${CONVERSATION}/events`]: () => json(200, { events: events() }),
    [`GET ${CONVERSATION}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${CONVERSATION}/tools`]: () => json(200, { tools: [] }),
    [`GET ${CONVERSATION}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${CONVERSATION}/device`]: () => json(200, { device: null }),
    [`GET ${CONVERSATION}/subagents`]: () => json(200, { subagents: [], next: null }),
    [`GET ${CONVERSATION}/background-tasks`]: () => json(200, { tasks: [] }),
    [`GET ${CONVERSATION}/usage`]: () =>
      json(200, {
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
  });
}

const emit = (e: ConversationEvent) =>
  act(() => {
    FakeEventSource.instances[0]?.emit("event", e);
  });
const nested = () => findNestedBoxes(document.body).map(describeNestedBox);

beforeEach(() => {
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
  api();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  window.history.replaceState(null, "", "/");
});

describe("generating image placeholders", () => {
  it("placeholders, then images in place", async () => {
    await renderChatRoute();
    const placeholders = await screen.findAllByRole("img", { name: GENERATING });
    expect(placeholders).toHaveLength(2);
    const stack = placeholders[0]?.closest("figure")?.parentElement;
    expect(stack).toBeTruthy();
    expect(placeholders[1]?.closest("figure")?.parentElement).toBe(stack);
    expect(nested()).toEqual([]);

    emit(image(5, "i1"));
    emit(image(6, "i2"));
    await waitFor(() => expect(screen.queryAllByRole("img", { name: GENERATING })).toEqual([]));
    const figures = ["i1", "i2"].map(
      (id) => screen.getByRole("img", { name: `${id}.png` }).closest("figure") as HTMLElement,
    );
    expect(figures.map((f) => f.parentElement)).toEqual([stack, stack]);
    expect(stack?.children[0]).toBe(figures[0]);
    expect(stack?.children[1]).toBe(figures[1]);
    for (const f of figures)
      expect(f.querySelector('[data-part="image-frame"]')?.getAttribute("data-ratio")).toBe("3:4");
    expect(nested()).toEqual([]);
  });

  it("one image in: it takes the first place, the second placeholder stays", async () => {
    await renderChatRoute();
    const [first] = await screen.findAllByRole("img", { name: GENERATING });
    const stack = first?.closest("figure")?.parentElement;
    emit(image(5, "i1"));
    await screen.findByRole("img", { name: "i1.png" });
    const left = screen.getAllByRole("img", { name: GENERATING });
    expect(left).toHaveLength(1);
    expect(left[0]?.getAttribute("aria-label")).toBe("Generating image 2/2, 3:4");
    expect(stack?.children[0]).toBe(screen.getByRole("img", { name: "i1.png" }).closest("figure"));
    expect(stack?.children[1]).toBe(left[0]?.closest("figure"));
  });

  it("a failed call removes them", async () => {
    await renderChatRoute();
    expect(await screen.findAllByRole("img", { name: GENERATING })).toHaveLength(2);
    emit(
      ev(5, "tool_result", {
        step: 1,
        callId: "g1",
        toolKey: "GenerateImage",
        content: "the model refused",
        isError: true,
      }),
    );
    await waitFor(() => expect(screen.queryAllByRole("img", { name: GENERATING })).toEqual([]));
  });
});
