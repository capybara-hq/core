import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { draftKey, refusedTokens } from "../src/components/conversation/ComposerBar";
import { startFirstMessage } from "../src/components/conversation/first-message-attempt";
import { ApiClientError } from "../src/lib/api";
import type { ConversationEvent, FirstMessageRequest } from "../src/lib/conversations";
import { personText } from "../src/lib/timeline";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  composerTokens,
  draftText,
  findComposerBox,
  pasteComposer,
  pressComposer,
  sendComposer,
  typeComposer,
} from "./support/composer";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

/**
 * Composer inline tokens (spec 2026-11-28, plan Task T9b): `@` and `/` picks are inline tokens in
 * the sentence; the message carries `text` with one U+FFFC per token and the ordered `tokens`;
 * uploads stay cards; a refusal marks its token with the Remove line; the bubble draws a logged
 * message's tokens from `payload.inline`, the skill chip first.
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
const MARK = "￼";
const SLACK = "8d0f6c1e-1111-4a2b-9c3d-000000000001";

const SLACK_ROW = {
  id: SLACK,
  slug: "slack",
  name: "Slack",
  description: "Team chat",
  descriptionZh: "团队聊天",
  icon: null,
  state: "ready",
  credential: "none",
  toolCount: 2,
  resources: true,
};

const SKILLS = {
  skills: [
    {
      id: "s2",
      name: "fix-issue",
      source: "platform",
      description: "Fix a GitHub issue",
      version: 3,
      argumentHint: "[issue-number]",
      manual: false,
      fork: false,
    },
    {
      id: "s5",
      name: "triage",
      source: "platform",
      description: "Triage a report",
      version: 1,
      manual: false,
      fork: false,
    },
  ],
};

function chatApi(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV("c1")),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    [`GET ${ORG}/files/limits`]: () => json(200, LIMITS),
    [`GET ${ORG}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${ORG}/conversations`]: () => json(200, { conversations: [], next: null }),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
    [`GET ${ORG}/agents/ag1/invocable-skills`]: () => json(200, SKILLS),
    [`GET ${ORG}/agents/ag1/mentionable-connectors`]: () => json(200, { connectors: [SLACK_ROW] }),
    ...extra,
  });
}

const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
const menu = async () => {
  await screen.findByRole("listbox");
  return document.querySelector('[data-part="composer-menu"]') as HTMLElement;
};
const accepted = () => json(202, { event: userMsg(9, "x") });
const markers = (s: string) => s.split(MARK).length - 1;

/** Types `before`, `@Sl`, picks Slack from the menu and types `after`. */
async function mentionSlack(before: string, after: string) {
  typeComposer(`${before}@Sl`);
  const el = await menu();
  await within(el).findByRole("option", { name: /Slack/ });
  pressComposer("Enter");
  typeComposer(after);
}

beforeEach(() => {
  params.conversationId = "c1";
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("composer tokens", () => {
  it("@Slack inserts a token mid-sentence and sends U+FFFC + tokens", async () => {
    const calls = chatApi({ [`POST ${BASE}/messages`]: accepted });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("给 @");
    const el = await menu();
    // the connectors group leads the first level; the row's → opens its resources
    const row = await within(el).findByRole("option", { name: /Slack/ });
    expect(row.textContent).toContain("Team chat");
    expect(
      [...el.querySelectorAll('[data-part="composer-menu-label"]')].map((h) => h.textContent),
    ).toContain(en.chat.composerMenu.connectorsGroup);
    typeComposer("Sl");
    pressComposer("Enter");
    expect(screen.getByRole("img", { name: "Connector: Slack" })).toBeTruthy();
    typeComposer("发消息");
    expect(draftText()).toBe("给 @Slack 发消息");
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = bodyOf(posts(calls)[0]) as Record<string, unknown>;
    expect(body.text).toBe(`给 ${MARK} 发消息`);
    expect(body.tokens).toEqual([{ type: "connector", connectorId: SLACK }]);
    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("conversationRefs");
    await vi.waitFor(() => expect(draftText()).toBe(""));
  });

  it("→ drills into a connector's resources and a resource becomes a token", async () => {
    const calls = chatApi({
      [`GET ${ORG}/connectors/resources`]: () =>
        json(200, {
          resources: [
            {
              connectorId: SLACK,
              connectorSlug: "slack",
              connectorName: "Slack",
              uri: "slack://channel/general",
              name: "general",
            },
          ],
          unavailable: [],
        }),
      [`POST ${BASE}/messages`]: accepted,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("@Sl");
    const el = await menu();
    await within(el).findByRole("option", { name: /Slack/ });
    pressComposer("ArrowRight");
    // the query that named the connector goes, the `@` stays; the second level lists one
    // connector's resources
    await vi.waitFor(() => expect(draftText()).toBe("@"));
    await within(await menu()).findByRole("option", { name: /general/ });
    expect(calls.some((c) => c.url === `${ORG}/connectors/resources?connectorId=${SLACK}`)).toBe(
      true,
    );
    pressComposer("Enter");
    expect(screen.getByRole("img", { name: "Resource: general" })).toBeTruthy();
    sendComposer("看看");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toMatchObject({
      text: `${MARK} 看看`,
      tokens: [{ type: "resource", connectorId: SLACK, uri: "slack://channel/general" }],
    });
  });

  it("uploads stay cards", async () => {
    const FILE = "11111111-1111-4111-8111-111111111111";
    const calls = chatApi({
      [`POST ${ORG}/files`]: () =>
        json(201, {
          file: {
            id: FILE,
            name: "notes.txt",
            contentType: "text/plain",
            size: 1,
            status: "draft",
          },
          upload: null,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      [`POST ${BASE}/messages`]: accepted,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    await mentionSlack("ask ", "");
    // a pasted file goes to the strip as a card, never into the sentence
    pasteComposer("", [new File(["x"], "notes.txt", { type: "text/plain" })]);
    const strip = await screen.findByRole("group", { name: en.chat.files });
    expect(within(strip).getAllByText("notes.txt").length).toBeGreaterThan(0);
    expect(composerTokens()).toHaveLength(1);
    await vi.waitFor(() => expect(within(strip).queryByRole("progressbar")).toBeNull());
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toMatchObject({
      text: `ask ${MARK}`,
      tokens: [{ type: "connector", connectorId: SLACK }],
      files: [FILE],
    });
  });

  it("second skill disabled", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("/");
    let el = await menu();
    await within(el).findByRole("option", { name: /fix-issue/ });
    typeComposer("fix");
    pressComposer("Enter");
    expect(screen.getByRole("img", { name: "Skill: /fix-issue" })).toBeTruthy();
    typeComposer("12 /");
    el = await menu();
    const triage = await within(el).findByRole("option", { name: /triage/ });
    expect(triage.getAttribute("aria-disabled")).toBe("true");
    expect(triage.textContent).toContain(en.chat.composerMenu.oneSkill);
    // no command mid-sentence: `/compact` only when the `/` is the whole draft
    expect(within(el).queryByRole("option", { name: /compact/ })).toBeNull();
  });

  it("a skill token leaves the text as `skill`, the seam collapsed", async () => {
    const calls = chatApi({ [`POST ${BASE}/messages`]: accepted });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("please /");
    await within(await menu()).findByRole("option", { name: /fix-issue/ });
    typeComposer("fix");
    pressComposer("Enter");
    sendComposer(" 123");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toMatchObject({
      text: "please 123",
      skill: { name: "fix-issue" },
    });
    expect(bodyOf(posts(calls)[0])).not.toHaveProperty("tokens");
  });

  it("pasted text with U+FFFC sends a matching marker count", async () => {
    const calls = chatApi({ [`POST ${BASE}/messages`]: accepted });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    await mentionSlack("", "");
    pasteComposer(`copied ${MARK}from a bubble​`);
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = bodyOf(posts(calls)[0]) as { text: string; tokens: unknown[] };
    expect(markers(body.text)).toBe(body.tokens.length);
    expect(body.tokens).toHaveLength(1);
    expect(body.text).toBe(`${MARK} copied from a bubble`);
  });

  it.each(["zh", "en"] as const)(
    "refusal marks the token and shows the Callout (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const calls = chatApi({
        [`POST ${BASE}/messages`]: () =>
          json(422, {
            error: {
              code: "conversation.connector_unavailable",
              message: "refused",
              details: [{ connectorId: SLACK, reason: "not_offered" }],
            },
          }),
      });
      await renderChatRoute({ locale });
      await screen.findByText("hi");
      await findComposerBox();
      await mentionSlack("给 ", "发消息");
      pressComposer("Enter");
      await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
      const reason = m.errors.conversation.connector_unavailable.not_offered;
      const line = await vi.waitFor(() => {
        const el = [...document.querySelectorAll('[data-part="callout"]')].find(
          (c) => c.getAttribute("data-tone") === "fail",
        );
        if (!el) throw new Error("no refusal line");
        return el as HTMLElement;
      });
      expect(line.textContent).toContain(
        locale === "zh" ? `Slack 不能使用：${reason}` : `Slack can't be used: ${reason}`,
      );
      const token = composerTokens()[0] as HTMLElement;
      expect(token.getAttribute("data-state")).toBe("refused");
      // the draft is given back as it was
      expect(draftText()).toBe("给 @Slack 发消息");
      const user = userEvent.setup();
      await user.click(
        within(line).getByRole("button", { name: locale === "zh" ? "移除" : "Remove" }),
      );
      await vi.waitFor(() => expect(composerTokens()).toHaveLength(0));
      expect(draftText()).toBe("给 发消息");
    },
  );

  it("restore after a failed send", async () => {
    let n = 0;
    const calls = chatApi({
      [`POST ${BASE}/messages`]: () => {
        n += 1;
        return n === 1
          ? json(503, { error: { code: "unavailable", message: "try later" } })
          : accepted();
      },
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    await mentionSlack("ask ", "now");
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    await vi.waitFor(() => expect(draftText()).toBe("ask @Slack now"));
    expect(screen.getByRole("img", { name: "Connector: Slack" })).toBeTruthy();
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(2));
    const id = (i: number) =>
      (bodyOf(posts(calls)[i]) as { clientMessageId: string }).clientMessageId;
    // the same draft is the same message: the retry keeps its id
    expect(id(1)).toBe(id(0));
  });
});

describe("composer review fixes", () => {
  it("a prompt picked mid-sentence goes where its / stood, the rest of the draft kept", async () => {
    const calls = chatApi({
      [`GET ${ORG}/connectors/prompts`]: () =>
        json(200, {
          prompts: [
            {
              connectorId: SLACK,
              connectorSlug: "slack",
              connectorName: "Slack",
              name: "standup",
              arguments: [],
            },
          ],
          unavailable: [],
        }),
      [`POST ${ORG}/connectors/${SLACK}/prompts/standup`]: () => json(200, { text: "STANDUP" }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    await mentionSlack("ask ", "then /st");
    const el = await menu();
    await within(el).findByRole("option", { name: /standup/ });
    pressComposer("Enter");
    await vi.waitFor(() =>
      expect(calls.some((c) => c.url === `${ORG}/connectors/${SLACK}/prompts/standup`)).toBe(true),
    );
    await vi.waitFor(() => expect(draftText()).toBe("ask @Slack then STANDUP"));
    expect(composerTokens()).toHaveLength(1);
  });

  it.each([
    ["File library", "files"],
    ["a connector's →", "level"],
  ])("＋ → %s opens its menu under StrictMode", async (_name, which) => {
    chatApi({
      [`GET ${ORG}/files`]: () =>
        json(200, {
          files: [
            {
              id: "lf1",
              name: "report.pdf",
              contentType: "application/pdf",
              size: 1,
              origin: "upload",
              agentId: null,
              sourceConversation: null,
              versions: 1,
              createdAt: "2026-11-24T08:00:00Z",
              previewable: null,
            },
          ],
          next: null,
        }),
      [`GET ${ORG}/connectors/resources`]: () =>
        json(200, {
          resources: [
            {
              connectorId: SLACK,
              connectorSlug: "slack",
              connectorName: "Slack",
              uri: "slack://general",
              name: "general",
            },
          ],
        }),
    });
    await renderChatRoute({ strict: true });
    await screen.findAllByText("hi");
    await findComposerBox();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    const plus = await menu();
    if (which === "files") {
      await user.click(
        await within(plus).findByRole("option", { name: en.chat.composerMenu.library }),
      );
      const el = await menu();
      await within(el).findByRole("option", { name: /report\.pdf/ });
      // only the library's files: no connectors group
      expect(within(el).queryByRole("option", { name: /Slack/ })).toBeNull();
    } else {
      await within(plus).findByRole("option", { name: /Slack/ });
      await user.click(
        within(plus).getByRole("button", {
          name: en.chat.composerMenu.drill.replace("{name}", "Slack"),
        }),
      );
      await within(await menu()).findByRole("option", { name: /general/ });
    }
  });

  it("refusals name resource, connector and project file tokens", () => {
    const err = (code: string, details: unknown[]) =>
      new ApiClientError(422, code, "refused", [], details);
    const res = { kind: "resource" as const, id: `${SLACK}:slack://a`, label: "a" };
    const res2 = { kind: "resource" as const, id: `${SLACK}:slack://b`, label: "b" };
    const conn = { kind: "connector" as const, id: SLACK, label: "Slack" };
    const pf = { kind: "projectFile" as const, id: "src/a.ts", label: "src/a.ts" };
    const longPath = `${"deep/".repeat(60)}gone.ts`;
    const pfLong = { kind: "projectFile" as const, id: longPath, label: longPath };
    const draft = [res, " ", res2, " ", conn, " ", pf, " ", pfLong];
    const ids = (e: unknown) => refusedTokens(e, draft).map((r) => r.id);
    expect(ids(err("connector.resources_disabled", [{ connectorId: SLACK }]))).toEqual([
      res.id,
      res2.id,
    ]);
    expect(ids(err("connector.not_found", [{ connectorId: SLACK }]))).toEqual([
      res.id,
      res2.id,
      SLACK,
    ]);
    expect(ids(err("connector.not_found", [{ connectorId: SLACK, uri: "slack://b" }]))).toEqual([
      res2.id,
    ]);
    expect(ids(err("conversation.project_file_unavailable", [{ reason: "no_project" }]))).toEqual([
      "src/a.ts",
      longPath,
    ]);
    // a path the kernel clipped matches by its prefix
    expect(
      ids(err("device.path_outside_project", [{ path: `${longPath.slice(0, 200)}…` }])),
    ).toEqual([longPath]);
  });

  it("uploads count the draft's library file tokens toward the per-message cap", async () => {
    chatApi({
      [`GET ${ORG}/files/limits`]: () => json(200, { ...LIMITS, maxPerMessage: 1 }),
      [`GET ${ORG}/files`]: () =>
        json(200, {
          files: [
            {
              id: "lf1",
              name: "report.pdf",
              contentType: "application/pdf",
              size: 1,
              origin: "upload",
              agentId: null,
              sourceConversation: null,
              versions: 1,
              createdAt: "2026-11-24T08:00:00Z",
              previewable: null,
            },
          ],
          next: null,
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("@");
    const el = await menu();
    await within(el).findByRole("option", { name: /report\.pdf/ });
    typeComposer("rep");
    await vi.waitFor(() => expect(within(el).getByRole("option", { name: /report\.pdf/ })));
    await userEvent.setup().click(within(el).getByRole("option", { name: /report\.pdf/ }));
    expect(screen.getByRole("img", { name: "File: report.pdf" })).toBeTruthy();
    pasteComposer("", [new File(["x"], "notes.txt", { type: "text/plain" })]);
    await screen.findByText(en.chat.filesLimit.replace("{max}", "1"));
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
  });
});

describe("bubble tokens open", () => {
  it("a conversation token links to its page, a library file token opens the file", async () => {
    const text = "see [conversation: Pricing] and [file: report.pdf]";
    chatApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, text, {
              inline: [
                { kind: "conversation", start: 4, end: 27, label: "Pricing", ref: { id: "c2" } },
                { kind: "file", start: 32, end: 50, label: "report.pdf", ref: { fileId: "lf1" } },
              ],
            }),
          ],
        }),
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderChatRoute();
    const link = await screen.findByRole("link", { name: "Conversation: Pricing" });
    expect(link.getAttribute("href")).toBe("/chat/c2");
    const file = screen.getByRole("button", { name: "File: report.pdf" });
    await userEvent.setup().click(file);
    // the file is not in the conversation's files list: it downloads (a tab opened for it)
    await vi.waitFor(() =>
      expect(open.mock.calls.some((c) => String(c[0]).includes("lf1"))).toBe(true),
    );
  });
});

describe("draft identity", () => {
  const slack = { kind: "connector" as const, id: SLACK, label: "Slack" };
  it("draft identity changes on token move, not on label refresh", () => {
    const key = draftKey(["给 ", slack, " 发消息"], ["up1"], undefined);
    // a label fetched later and a refusal mark are the same draft
    expect(
      draftKey(
        ["给 ", { ...slack, label: "Slack (team)", state: "refused" }, " 发消息"],
        ["up1"],
        undefined,
      ),
    ).toBe(key);
    // a moved token, another upload or a skill are a new message
    expect(draftKey([slack, " 给  发消息"], ["up1"], undefined)).not.toBe(key);
    expect(draftKey(["给 ", slack, " 发消息"], [], undefined)).not.toBe(key);
    expect(draftKey(["给 ", slack, " 发消息"], ["up1"], "fix-issue")).not.toBe(key);
  });

  it("first-message attempt carries segments", () => {
    const request: FirstMessageRequest = {
      agentId: "ag1",
      message: { text: `给 ${MARK}`, tokens: [{ type: "connector", connectorId: SLACK }] },
      permission: { profile: "approve-for-me" },
    };
    const draft = { segments: ["给 ", slack], skill: null, files: [] };
    const attempt = startFirstMessage(
      "o1",
      request,
      { text: request.message.text, clientMessageId: "m1", draft },
      "m1",
    );
    expect(attempt.message.draft?.segments).toEqual(["给 ", slack]);
    expect(JSON.parse(attempt.serializedBody).message).toMatchObject({
      text: `给 ${MARK}`,
      tokens: [{ type: "connector", connectorId: SLACK }],
    });
    // another token makes another logical request
    const other = startFirstMessage(
      "o1",
      { ...request, message: { ...request.message, tokens: [{ type: "conversation", id: "c2" }] } },
      { text: request.message.text, clientMessageId: "m2" },
      "m2",
    );
    expect(other.intentKey).not.toBe(attempt.intentKey);
  });
});

describe("the bubble", () => {
  const inline = (start: number, end: number) => ({
    kind: "connector",
    start,
    end,
    label: "Slack",
    ref: { connectorId: SLACK },
  });

  it("draws a logged message's tokens in its sentence", async () => {
    const text = "给 [connector: Slack] 发消息";
    chatApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [userMsg(1, text, { inline: [inline(2, 20)] })],
        }),
    });
    await renderChatRoute();
    const token = await screen.findByRole("img", { name: "Connector: Slack" });
    const bubble = token.closest('[data-part="bubble"]') as HTMLElement;
    expect(bubble.textContent).toContain("给 ");
    expect(bubble.textContent).toContain(" 发消息");
    expect(bubble.textContent).not.toContain("[connector:");
  });

  it("bubble draws skill chip then argument tokens", async () => {
    const args = "[connector: Slack] ping";
    chatApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, 'The user invoked the skill "fix-issue".', {
              skill: {
                id: "s2",
                version: 3,
                source: "skills/s2/",
                name: "fix-issue",
                arguments: args,
                mode: "inline",
              },
              inline: [inline(0, 18)],
            }),
          ],
        }),
    });
    await renderChatRoute();
    const token = await screen.findByRole("img", { name: "Connector: Slack" });
    const bubble = token.closest('[data-part="bubble"]') as HTMLElement;
    const chip = bubble.querySelector('[data-part="bubble-skill"]') as HTMLElement;
    expect(chip.textContent).toBe("/fix-issue");
    // the chip first, then the token, then the rest of the arguments
    expect(chip.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bubble.textContent).toContain(" ping");
  });
});

describe("personText", () => {
  const payload = (content: unknown[], extra: Record<string, unknown> = {}) =>
    (
      ev(1, "user_message", { content, authorAccountId: "a1", ...extra }, null) as Extract<
        ConversationEvent,
        { type: "user_message" }
      >
    ).payload;
  const image = { type: "image", mediaType: "image/png", source: { kind: "ref", fileId: "f1" } };

  it("personText skips a leading file line and keeps old messages", () => {
    // an upload-only message: content[0] is the file's line
    expect(personText(payload([{ type: "text", text: "[file: a.png]" }, image]))).toBe("");
    // a message with text keeps it; the uploads' lines never show
    expect(
      personText(
        payload([{ type: "text", text: "look" }, { type: "text", text: "[file: a.png]" }, image]),
      ),
    ).toBe("look");
    // an older message (text, then a bare image) keeps its text
    expect(personText(payload([{ type: "text", text: "old text" }, image]))).toBe("old text");
    // with tokens only content[0], the sentence
    expect(
      personText(
        payload(
          [
            { type: "text", text: "给 [connector: Slack]" },
            { type: "text", text: "[connector: Slack] The person named the connector" },
          ],
          {
            inline: [
              { kind: "connector", start: 2, end: 20, label: "Slack", ref: { connectorId: SLACK } },
            ],
          },
        ),
      ),
    ).toBe("给 [connector: Slack]");
  });
});
