import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import NewChatPage from "../src/app/[locale]/(app)/chat/page";
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
 * Phase D Task 11: the composer's `/` menu lists the agent's skills first (then the connector
 * prompts); picking one shows the skill chip and the text after it is the arguments; a typed
 * `/name args` is sent as an invocation of a listed skill; the bubble shows the chip, the
 * arguments and the rendered instructions; a fork shows its sub-agent row and the report.
 */

const params = { conversationId: "c1" };
const search = new URLSearchParams();
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useSearchParams: () => search,
}));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;
const INVOCABLE = `${ORG}/agents/ag1/invocable-skills`;

const SKILLS = {
  skills: [
    {
      id: "s1",
      name: "brainstorming",
      plugin: "superpowers",
      description: "Think before building",
      version: 1,
      manual: false,
      fork: false,
    },
    {
      id: "s2",
      name: "fix-issue",
      description: "Fix a GitHub issue",
      version: 3,
      argumentHint: "[issue-number]",
      manual: false,
      fork: false,
    },
    {
      id: "s3",
      name: "release-check",
      description: "Run the release checks",
      version: 1,
      manual: true,
      fork: false,
    },
    {
      id: "s4",
      name: "review",
      description: "Review in a sub-agent",
      version: 1,
      argumentHint: "[path]",
      manual: false,
      fork: true,
    },
  ],
};
const PROMPTS = {
  prompts: [
    {
      connectorId: "a1",
      connectorSlug: "docs",
      connectorName: "Docs",
      name: "summarize",
      description: "Summarize a topic",
      arguments: [],
    },
  ],
  unavailable: [],
};

const RENDERED =
  'The user invoked the skill "fix-issue" with /fix-issue 123. Follow its instructions for this request.\n\n<skill_invocation name="fix-issue" version="3">\nFix GitHub issue 123.\n</skill_invocation>';
const skillRecord = (over: Record<string, unknown> = {}) => ({
  id: "s2",
  version: 3,
  source: "skills/s2/",
  name: "fix-issue",
  arguments: "123",
  mode: "inline",
  ...over,
});
const invocation = (seq: number, text = RENDERED, skill = skillRecord()) =>
  userMsg(seq, text, { skill });

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
    [`GET ${ORG}/connectors/prompts`]: () => json(200, PROMPTS),
    ...extra,
  });
}

const input = () => screen.getByRole("textbox", { name: en.chat.inputLabel, hidden: true });
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url.split("?")[0] === path);
const sentMessage = (c: Call) => {
  const b = bodyOf(c) as { text: string; skill?: unknown; clientMessageId: string };
  return { text: b.text, ...(b.skill !== undefined ? { skill: b.skill } : {}) };
};
const echo = (c: Call) =>
  json(202, {
    event: userMsg(9, (bodyOf(c) as { text: string }).text),
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

describe("the / menu", () => {
  it("lists the agent's skills first, sorted, with tags and the argument hint; then the connector prompts", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("/fix-issue");
    const headings = [...dialog.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
    expect(headings).toEqual([en.chat.skillsGroup, "Docs"]);
    const options = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual([
      "/brainstormingThink before buildingsuperpowers",
      "/fix-issue[issue-number]Fix a GitHub issue",
      `/release-check${en.chat.skillTag.manual}Run the release checks`,
      `/review[path]${en.chat.skillTag.fork}Review in a sub-agent`,
      "/docs:summarizeSummarize a topic",
    ]);
    // the plugin a skill came from is its secondary label (spec §3.2)
    const brainstorming = within(dialog).getAllByRole("option")[0] as HTMLElement;
    expect(brainstorming.querySelector('[data-part="palette-source"]')?.textContent).toBe(
      "superpowers",
    );
    // loaded for the conversation's agent, with the conversation (its trial drafts)
    expect(calls.some((c) => c.url === `${INVOCABLE}?conversationId=c1`)).toBe(true);
  });

  it("typing narrows the list; /superpowers:brainstorming finds brainstorming", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("/fix-issue");
    const query = within(dialog).getByRole("combobox");
    await user.type(query, "fix");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["/fix-issue[issue-number]Fix a GitHub issue"]);
    await user.clear(query);
    await user.type(query, "superpowers:brain");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["/brainstormingThink before buildingsuperpowers"]);
  });

  it("picking a skill shows the chip; the text after it is sent as its arguments", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: () => json(202, { event: invocation(2) }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await user.click(await screen.findByRole("option", { name: /^\/fix-issue/ }));
    expect(input()).toHaveProperty("value", "");
    expect(document.querySelector('[data-part="composer-token"]')?.textContent).toContain(
      "/fix-issue",
    );
    // the argument hint is the placeholder
    expect(input().getAttribute("placeholder")).toBe("[issue-number]");
    await user.type(input(), "123{Enter}");
    const post = posts(calls, `${BASE}/messages`);
    expect(post).toHaveLength(1);
    expect(sentMessage(post[0] as Call)).toEqual({ text: "123", skill: { name: "fix-issue" } });
    // sent: the chip is gone
    await vi.waitFor(() =>
      expect(document.querySelector('[data-part="composer-token"]')).toBeNull(),
    );
  });

  it("a skill without arguments can be sent with the chip alone; Backspace removes the chip", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: () =>
        json(202, {
          event: invocation(2, "x", skillRecord({ name: "release-check", arguments: "" })),
        }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await user.click(await screen.findByRole("option", { name: /^\/release-check/ }));
    await user.type(input(), "{Backspace}");
    expect(document.querySelector('[data-part="composer-token"]')).toBeNull();
    await user.type(input(), "/");
    await user.click(await screen.findByRole("option", { name: /^\/release-check/ }));
    await user.click(screen.getByRole("button", { name: en.chat.send }));
    expect(sentMessage(posts(calls, `${BASE}/messages`)[0] as Call)).toEqual({
      text: "",
      skill: { name: "release-check" },
    });
  });
});

describe("typed /name", () => {
  it("/fix-issue 7 without the menu is sent as an invocation; /nope 7 and /etc/hosts as text", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: echo,
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    // pasted, so the menu never opens
    await user.click(input());
    await user.paste("/fix-issue 7");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    await user.paste("/nope 7");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    await user.paste("/etc/hosts");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(3));
    await user.paste("/superpowers:brainstorming  a b ");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(4));
    expect(posts(calls, `${BASE}/messages`).map((c) => sentMessage(c))).toEqual([
      { text: "7", skill: { name: "fix-issue" } },
      { text: "/nope 7" },
      { text: "/etc/hosts" },
      { text: "a b", skill: { name: "superpowers:brainstorming" } },
    ]);
  });
});

describe("a pending send", () => {
  it("text typed while a send is pending is kept when it returns; only what was sent is cleared", async () => {
    let release: (() => void) | undefined;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: (c) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(echo(c));
        }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("first");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    // typed after the send left, before it returns
    await user.paste(" and then");
    expect((input() as HTMLTextAreaElement).value).toBe("first and then");
    release?.();
    await vi.waitFor(() => expect((input() as HTMLTextAreaElement).value).toBe("and then"));
    // a draft replaced while pending stays whole
    await user.clear(input());
    await user.paste("second");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    await user.clear(input());
    await user.paste("other");
    release?.();
    await vi.waitFor(() =>
      expect(posts(calls, `${BASE}/messages`).map(sentMessage)).toEqual([
        { text: "first" },
        { text: "second" },
      ]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect((input() as HTMLTextAreaElement).value).toBe("other");
  });
});

describe("queueing an invocation", () => {
  it("⌘↵ while running queues with the skill; the queued bubble shows the chip", async () => {
    let items: unknown[] = [];
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`GET ${BASE}/queue`]: () => json(200, { items, paused: false }),
      [`POST ${BASE}/queue`]: (c) => {
        const item = {
          id: "q1",
          text: "9",
          files: [],
          attachments: [],
          clientMessageId: (bodyOf(c) as { clientMessageId: string }).clientMessageId,
          model: null,
          effort: null,
          createdAt: "2026-10-26T06:00:00.000Z",
          position: 1,
          skill: { name: "fix-issue", arguments: "9", mode: "inline" },
        };
        items = [item];
        return json(201, { item });
      },
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await user.click(await screen.findByRole("option", { name: /^\/fix-issue/ }));
    await user.type(input(), "9{Meta>}{Enter}{/Meta}");
    expect(sentMessage(posts(calls, `${BASE}/queue`)[0] as Call)).toEqual({
      text: "9",
      skill: { name: "fix-issue" },
    });
    const list = await screen.findByRole("group", { name: en.chat.queueLabel });
    await vi.waitFor(() =>
      expect(
        list.querySelector('[data-queue-item="q1"] [data-part="bubble-skill"]')?.textContent,
      ).toBe("/fix-issue"),
    );
  });

  it("a typed /name args with ⌘↵ while running queues the invocation", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/queue`]: () => json(201, { item: null }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/fix-issue 9");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/queue`)).toHaveLength(1));
    expect(sentMessage(posts(calls, `${BASE}/queue`)[0] as Call)).toEqual({
      text: "9",
      skill: { name: "fix-issue" },
    });
  });

  it("a queue paused because the head's skill can no longer be invoked says so", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}/queue`]: () =>
        json(200, {
          items: [
            {
              id: "q1",
              text: "9",
              files: [],
              attachments: [],
              clientMessageId: "cm",
              model: null,
              effort: null,
              createdAt: "2026-10-26T06:00:00.000Z",
              position: 1,
              skill: { name: "fix-issue", arguments: "9", mode: "inline" },
            },
          ],
          paused: true,
          pauseReason: "skill_not_invocable",
        }),
    });
    renderPage(<ChatPage />, { locale: "zh" });
    expect(await screen.findByText(zh.chat.queuePaused.skill_not_invocable)).toBeTruthy();
    expect(screen.queryByText(/运行已停止/)).toBeNull();
  });
});

describe("the invocation in the thread", () => {
  it("the bubble shows the chip and the arguments; the disclosure holds what was sent", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [invocation(1)] }) });
    renderPage(<ChatPage />, { locale: "en" });
    const bubble = await vi.waitFor(() => {
      const b = document.querySelector('[data-entry="user"] [data-part="bubble"]');
      if (!b) throw new Error("no bubble");
      return b;
    });
    expect(bubble.querySelector('[data-part="bubble-skill"]')?.textContent).toBe("/fix-issue");
    expect(bubble.textContent).toBe("/fix-issue123");
    expect(screen.queryByText(/Fix GitHub issue 123/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: en.chat.skillInstructions }));
    expect(screen.getByText(/Fix GitHub issue 123/).textContent).toBe(RENDERED);
  });

  it("a fork: the sub-agent row under the bubble, then the report, then the reply", async () => {
    const fork = invocation(
      1,
      'The user ran the skill "review" in a sub-agent (general-purpose) with /review src. …',
      skillRecord({
        name: "review",
        arguments: "src",
        mode: "fork",
        agentType: "general-purpose",
      }),
    );
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            fork,
            runStarted(2),
            ev(3, "subagent_dispatched", {
              step: 0,
              callId: "skill-1",
              subagentId: "child-1",
              childRunId: "cr1",
              agentType: "general-purpose",
              description: "review",
              resumed: false,
              model: { provider: "model-fake", model: "fake-1" },
              invokedSeq: 1,
            }),
            ev(4, "subagent_finished", {
              subagentId: "child-1",
              childRunId: "cr1",
              callId: "skill-1",
              status: "completed",
              toolCalls: 2,
              durationMs: 1200,
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            }),
            ev(5, "skill_fork_result", {
              invokedSeq: 1,
              subagentId: "child-1",
              childRunId: "cr1",
              text: 'Report from the sub-agent that ran the skill "review":\n\nLooks good.',
            }),
            ev(6, "assistant_message", {
              step: 1,
              content: [{ type: "text", text: "The review found nothing." }],
              stopReason: "end_turn",
            }),
          ],
        }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("The review found nothing.");
    const kinds = [...document.querySelectorAll("[data-entry]")].map((e) =>
      e.getAttribute("data-entry"),
    );
    expect(kinds).toEqual(["user", "subagents", "skill-report", "prose"]);
    const bubble = document.querySelector('[data-entry="user"] [data-part="bubble"]');
    expect(bubble?.textContent).toBe("/reviewsrc");
    const row = document.querySelector('[data-entry="subagents"]') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row).getAllByRole("button")[0] as HTMLElement);
    expect(row.textContent).toContain("general-purpose");
    const report = document.querySelector('[data-entry="skill-report"]') as HTMLElement;
    expect(within(report).queryByText(/Looks good/)).toBeNull();
    await user.click(within(report).getByRole("button", { name: en.chat.skillReport }));
    expect(within(report).getByText(/Looks good/)).toBeTruthy();
  });

  it("a plain message absorbed into a later fork's run waits for the sub-agent, not stuck", async () => {
    const fork = invocation(
      2,
      "lead",
      skillRecord({ name: "review", arguments: "", mode: "fork", agentType: "general-purpose" }),
    );
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "also check the docs"),
            fork,
            runStarted(3),
            ev(4, "subagent_dispatched", {
              step: 0,
              callId: "skill-2",
              subagentId: "child-1",
              childRunId: "cr1",
              agentType: "general-purpose",
              description: "review",
              resumed: false,
              model: { provider: "model-fake", model: "fake-1" },
              invokedSeq: 2,
            }),
          ],
        }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const plain = (await screen.findByText("also check the docs")).closest(
      "[data-entry]",
    ) as HTMLElement;
    expect(plain.textContent).toContain(en.chat.skillWaits.replace("{skill}", "/review"));
    // the fork's own bubble carries no such note
    const bubbles = document.querySelectorAll('[data-entry="user"]');
    expect(bubbles[1]?.textContent).not.toContain(en.chat.skillWaits.replace("{skill}", "/review"));
  });

  it("a sub-agent's task message is a task, never a person's invocation (batch 3 ruling)", async () => {
    params.conversationId = "c1";
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "Review src.", {
              skill: skillRecord({ name: "review", mode: "fork" }),
              dispatch: { parentConversationId: "p1", parentRunId: "pr", callId: "skill-1" },
            }),
          ],
        }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await vi.waitFor(() => expect(document.querySelector('[data-entry="task"]')).not.toBeNull());
    expect(document.querySelector('[data-part="bubble-skill"]')).toBeNull();
  });
});

describe("a new conversation", () => {
  it("lists the picked agent's skills without a conversation and sends the first message with the skill", async () => {
    resetNavigation("/chat");
    const calls = api({
      [`GET ${ORG}/conversations/groups`]: () => json(200, { groups: [] }),
      [`POST ${ORG}/conversations`]: () =>
        json(201, { conversation: CONV().conversation, event: invocation(1) }),
    });
    renderPage(<NewChatPage />, { locale: "en" });
    await vi.waitFor(() => expect(input()).toHaveProperty("disabled", false));
    const user = userEvent.setup();
    await user.type(input(), "/");
    await user.click(await screen.findByRole("option", { name: /^\/fix-issue/ }));
    await user.type(input(), "123{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${ORG}/conversations`)).toHaveLength(1));
    expect(
      (bodyOf(posts(calls, `${ORG}/conversations`)[0]) as { message: unknown }).message,
    ).toMatchObject({ text: "123", skill: { name: "fix-issue" } });
    expect(calls.some((c) => c.url === INVOCABLE)).toBe(true);
    act(() => {});
  });
});
