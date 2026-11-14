import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
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
 * Context compaction spec §4.10: manual compaction from the conversation page — the title menu's
 * "Compact conversation" and the composer's built-in `/compact` (before skill lookup, no
 * arguments). Both call `POST .../compact`; the command sends no user message. The compacting row
 * follows the `compaction` SSE frame and clears on every terminal run status (Task 9 ruling: a
 * manual early skip writes no compaction event and finishes `completed`).
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
const COMPACT = `${BASE}/compact`;
const INVOCABLE = `${ORG}/agents/ag1/invocable-skills`;

const SKILLS = {
  skills: [
    {
      id: "s1",
      name: "brainstorming",
      description: "Think before building",
      version: 1,
      manual: false,
      fork: false,
    },
  ],
};

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
    [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
    ...extra,
  });
}

const input = () => screen.getByRole("textbox", { name: en.chat.inputLabel, hidden: true });
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url.split("?")[0] === path);
const compactPosts = (calls: Call[]) => posts(calls, COMPACT);
const messagePosts = (calls: Call[]) => posts(calls, `${BASE}/messages`);

/** A `compaction` SSE frame of this conversation (stream.ts drops other conversations'). */
const frame = (runId: string, startedAt = Date.now()) => ({
  runId,
  conversationId: "c1",
  phase: "summarizing",
  step: 1,
  startedAt,
});

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

describe("/compact", () => {
  it("calls the compact endpoint with {} and sends no user message", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    // pasted: the palette never opens
    await user.paste("/compact");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(compactPosts(calls)).toHaveLength(1));
    // the kernel validates the body: the client sends {} (not no body)
    expect(bodyOf(compactPosts(calls)[0])).toEqual({});
    expect(messagePosts(calls)).toHaveLength(0);
    // the command is not a draft: it clears
    await vi.waitFor(() => expect((input() as HTMLTextAreaElement).value).toBe(""));
  });

  it("/compact with arguments shows a hint and sends nothing (the draft stays to fix)", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/compact now");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(en.chat.compactNoArgs)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(compactPosts(calls)).toHaveLength(0);
    expect(messagePosts(calls)).toHaveLength(0);
    expect((input() as HTMLTextAreaElement).value).toBe("/compact now");
  });

  it("does not compact while a run is active: it says so and sends nothing", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/compact");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(en.chat.compactBusy)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(compactPosts(calls)).toHaveLength(0);
    expect(messagePosts(calls)).toHaveLength(0);
  });

  it("a failed compact shows the kernel error and keeps the draft", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${COMPACT}`]: () =>
        json(409, { error: { code: "conversation.busy", message: "busy" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/compact");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(en.errors.conversation.busy)).toBeTruthy();
    await vi.waitFor(() => expect(compactPosts(calls)).toHaveLength(1));
    expect((input() as HTMLTextAreaElement).value).toBe("/compact");
  });

  it("is not a skill: an agent skill named compact does not capture the built-in command", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${INVOCABLE}`]: () => json(200, { skills: [{ ...SKILLS.skills[0], name: "compact" }] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/compact");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(compactPosts(calls)).toHaveLength(1));
    expect(messagePosts(calls)).toHaveLength(0);
  });
});

describe("the title menu", () => {
  it("'Compact conversation' compacts the idle conversation", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Untitled conversation/ }));
    await user.click(await screen.findByRole("menuitem", { name: en.chat.compact }));
    await vi.waitFor(() => expect(compactPosts(calls)).toHaveLength(1));
    expect(bodyOf(compactPosts(calls)[0])).toEqual({});
    expect(messagePosts(calls)).toHaveLength(0);
  });

  it("is disabled while a run is active", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Untitled conversation/ }));
    const item = await screen.findByRole("menuitem", { name: en.chat.compact });
    expect(
      item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await user.click(item);
    await new Promise((r) => setTimeout(r, 50));
    expect(compactPosts(calls)).toHaveLength(0);
  });

  it("is hidden for a sub-agent's conversation (compaction is impossible there)", async () => {
    // An eval conversation never renders this page at all: the kernel answers 404 for it and only
    // the trajectory viewer shows it. A sub-agent's conversation does render, and the endpoint
    // refuses it (conversation.read_only), so the action is hidden there too.
    api({
      [`GET ${BASE}`]: () => json(200, CONV("c1", { parentConversationId: "p1" })),
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Untitled conversation/ }));
    await screen.findByRole("menuitem", { name: en.chat.rename });
    expect(screen.queryByRole("menuitem", { name: en.chat.compact })).toBeNull();
  });
});

describe("the / menu command entry", () => {
  it("lists /compact beside the agent's skills and picking it compacts", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${COMPACT}`]: () => json(202, { runId: "cr1" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    const dialog = await screen.findByRole("dialog");
    const headings = [...dialog.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
    expect(headings).toEqual([en.chat.commandsGroup, en.chat.skillsGroup]);
    const command = await within(dialog).findByRole("option", { name: /^\/compact/ });
    await user.click(command);
    await vi.waitFor(() => expect(compactPosts(calls)).toHaveLength(1));
    expect(messagePosts(calls)).toHaveLength(0);
  });
});

describe("the compacting row", () => {
  it("appears from the SSE frame and clears on every terminal run status", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    await renderChatRoute();
    await screen.findByText("hi");
    const es = () => FakeEventSource.instances[0];
    const row = () => document.querySelector('[data-role="compacting-row"]');
    const terminals = [
      ["run_finished", { reason: "completed", consumedUpToSeq: 1 }],
      ["run_failed", { error: { code: "model.unavailable", message: "x" } }],
      ["run_aborted", { byAccountId: "a1", reason: "user" }],
    ] as const;
    let seq = 10;
    for (const [type, payload] of terminals) {
      act(() => es()?.emit("compaction", frame("cr1")));
      expect(await screen.findByText(/Compacting conversation/)).toBeTruthy();
      expect(row()).not.toBeNull();
      // a terminal status with no compaction_summary/compaction_failed (a manual early skip is
      // silent and finishes completed) still clears the row
      act(() => es()?.emit("event", ev(seq++, type, payload, "cr1")));
      await vi.waitFor(() => expect(row()).toBeNull());
    }
  });
});

describe("i18n", () => {
  it("shows the Chinese copy for the menu entry and the no-argument hint", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^未命名会话/ }));
    expect(await screen.findByRole("menuitem", { name: zh.chat.compact })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("textbox", { name: zh.chat.inputLabel, hidden: true }));
    await user.paste("/compact foo");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(zh.chat.compactNoArgs)).toBeTruthy();
  });
});
