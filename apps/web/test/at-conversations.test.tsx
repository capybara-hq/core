import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { refusedTokens } from "../src/components/conversation/ComposerBar";
import { ApiClientError } from "../src/lib/api";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  backspaceComposer,
  composerTokens,
  draftText,
  findComposerBox,
  pressComposer,
  sendComposer,
  typeComposer,
} from "./support/composer";
import {
  AGENTS,
  CONV,
  DEVICES,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  permissionPreview,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

/**
 * @ conversations (spec 2026-11-28 @ conversations §3, composer inline tokens spec): the `@`
 * menu's conversations group lists the sender's conversations by title (never the one written
 * in), a pick becomes an inline `conversation` token sent in `tokens` (the first message too), a
 * refusal marks the refused tokens with the Remove line, and the bubble shows an older logged
 * message's references as link chips, never their quoted blocks.
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
const LIST = `${ORG}/conversations`;
const RESOURCES = `${ORG}/connectors/resources`;
const LIBRARY = `${ORG}/files`;

const agent = { id: "ag1", name: "Echo agent", profile: { avatar: null, updatedAt: null } };
const row = (id: string, title: string | null) => ({
  ...CONV(id, { title, updatedAt: "2026-11-27T08:00:00.000Z" }).conversation,
  agent,
});
const MINE = [
  row("c1", "This conversation"),
  row("c2", "Quarterly plan"),
  row("c3", null),
  row("c4", "Release notes"),
  row("c5", "Quarterly review"),
];
/** The list route as the kernel answers it: titles containing `q`, at most `limit`. */
const listing = (c: Call) => {
  const u = new URL(c.url, "http://x");
  const q = (u.searchParams.get("q") ?? "").toLowerCase();
  const limit = Number(u.searchParams.get("limit") ?? 30);
  return json(200, {
    conversations: MINE.filter((r) => (r.title ?? "").toLowerCase().includes(q)).slice(0, limit),
    next: null,
  });
};
const listReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === LIST).map((c) => c.url);
const posts = (calls: Call[], url: string) =>
  calls.filter((c) => c.method === "POST" && c.url === url);

/**
 * The routes the `@` menu reads besides the conversations: one library file, no connectors (a
 * resource is listed only in its connector's second level).
 */
const menuRoutes = {
  [`GET ${LIBRARY}`]: () =>
    json(200, {
      files: [
        {
          id: "lf1",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 1024,
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
  [`GET ${RESOURCES}`]: () =>
    json(200, {
      resources: [
        {
          connectorId: "k1",
          connectorSlug: "docs",
          connectorName: "Docs",
          uri: "docs://handbook",
          name: "Handbook",
        },
      ],
      unavailable: [],
    }),
  [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
  [`GET ${ORG}/agents/ag1/mentionable-connectors`]: () => json(200, { connectors: [] }),
  [`GET ${ORG}/agents/ag2/mentionable-connectors`]: () => json(200, { connectors: [] }),
  [`GET ${LIST}`]: listing,
};

function chatApi(
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
  events: unknown[] = [userMsg(1, "hi")],
) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV("c1")),
    [`GET ${BASE}/events`]: () => json(200, { events }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    ...menuRoutes,
    ...extra,
  });
}

const MARK = "￼";
const menu = async () => {
  await screen.findByRole("listbox");
  return document.querySelector('[data-part="composer-menu"]') as HTMLElement;
};
const headingsOf = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-part="composer-menu-label"]')].map((h) => h.textContent);
/** The draft's conversation token titled `title`, as drawn. */
const tokenOf = (title: string) =>
  screen.getByRole("img", { name: new RegExp(`^(Conversation: |会话：)${title}`) });
/** Types `@`, waits for the conversations row named `name` and picks it. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await findComposerBox();
  typeComposer("@");
  const el = await menu();
  await user.click(await within(el).findByRole("option", { name }));
}
const refusal = (code: string, details: unknown[]) => () =>
  json(422, { error: { code, message: "refused", details } });
/** The refusal line (the fail Callout) once it shows. */
const refusalLine = () =>
  vi.waitFor(() => {
    const el = [...document.querySelectorAll('[data-part="callout"]')].find(
      (c) => c.getAttribute("data-tone") === "fail",
    );
    if (!el) throw new Error("no refusal line");
    return el as HTMLElement;
  });

beforeEach(() => {
  params.conversationId = "c1";
  for (const k of [...search.keys()]) search.delete(k);
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("the @ menu's conversations group", () => {
  it("lists my recent conversations after the files, never this one", async () => {
    const calls = chatApi();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("@");
    const el = await menu();
    await within(el).findByRole("option", { name: /Quarterly plan/ });
    await within(el).findByText("report.pdf");
    expect(headingsOf(el)).toEqual([
      zh.chat.composerMenu.recentFiles,
      zh.chat.composerMenu.conversations,
    ]);
    // the empty query reads the newest six, the current one is dropped
    expect(listReads(calls)).toEqual([`${LIST}?limit=9`]);
    expect(within(el).queryByText("This conversation")).toBeNull();
    const plan = within(el).getByRole("option", { name: /Quarterly plan/ });
    expect(
      plan
        .querySelector('[data-part="composer-menu-lead"] [data-part="icon"]')
        ?.getAttribute("data-icon"),
    ).toBe("chats");
    expect(plan.textContent).toContain("Echo agent · ");
    // an untitled conversation reads "Untitled conversation"
    expect(
      within(el).getByRole("option", {
        name: new RegExp(zh.chat.composerMenu.untitledConversation),
      }),
    ).toBeTruthy();
  });

  it("searches titles with the rested query and keeps at most five rows", async () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`d${i}`, `Doc ${i}`));
    const calls = chatApi({
      [`GET ${LIST}`]: (c) => {
        const q = new URL(c.url, "http://x").searchParams.get("q");
        return q === null ? json(200, { conversations: many, next: null }) : listing(c);
      },
    });
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("@");
    let el = await menu();
    await within(el).findByRole("option", { name: /Doc 0/ });
    expect(within(el).queryByRole("option", { name: /Doc 5/ })).toBeNull();
    typeComposer("quarterly");
    await vi.waitFor(() => expect(listReads(calls)).toContain(`${LIST}?limit=9&q=quarterly`));
    el = await menu();
    await within(el).findByRole("option", { name: /Quarterly review/ });
    await vi.waitFor(() =>
      expect(within(el).queryByRole("option", { name: /Release notes/ })).toBeNull(),
    );
    // only the query the typing left is read
    expect(listReads(calls)).toEqual([`${LIST}?limit=9`, `${LIST}?limit=9&q=quarterly`]);
  });

  it("is not listed by + → File library", async () => {
    const calls = chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.library }));
    await within(await menu()).findByText("report.pdf");
    expect(listReads(calls)).toEqual([]);
  });

  it("a pick becomes an inline token; the message carries it in tokens", async () => {
    const calls = chatApi({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    expect(tokenOf("Quarterly plan")).toBeTruthy();
    expect(draftText()).toBe("@Quarterly plan ");
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
    // a picked conversation is not offered again
    typeComposer("@");
    const el = await menu();
    await within(el).findByRole("option", { name: /Release notes/ });
    expect(within(el).queryByRole("option", { name: /Quarterly plan/ })).toBeNull();
    pressComposer("Escape");
    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    backspaceComposer();
    // a token alone can be sent: it renders a placeholder
    expect((screen.getByRole("button", { name: en.chat.send }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    sendComposer("compare");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    const body = bodyOf(posts(calls, `${BASE}/messages`)[0]) as Record<string, unknown>;
    expect(body).toMatchObject({
      text: `${MARK} compare`,
      tokens: [{ type: "conversation", id: "c2" }],
    });
    expect(body).not.toHaveProperty("conversationRefs");
    await vi.waitFor(() => expect(composerTokens()).toHaveLength(0));
  });

  it("the pending bubble draws the reference as a token", async () => {
    chatApi({ [`POST ${BASE}/messages`]: () => new Promise<Response>(() => {}) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    sendComposer("compare");
    const bubble = await vi.waitFor(() => {
      const el = document.querySelector("[data-pending]");
      if (!el) throw new Error("no pending bubble");
      return el as HTMLElement;
    });
    expect(within(bubble).getByRole("img", { name: "Conversation: Quarterly plan" })).toBeTruthy();
    expect(bubble.textContent).toContain("compare");
  });

  it("with three referenced the rows are disabled and say why", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    await pick(user, /Release notes/);
    await pick(user, /Quarterly review/);
    typeComposer("@");
    const el = await menu();
    const untitled = await within(el).findByRole("option", {
      name: new RegExp(en.chat.composerMenu.untitledConversation),
    });
    const limit = en.chat.composerMenu.conversationLimit.replace("{max}", "3");
    expect(untitled.getAttribute("aria-disabled")).toBe("true");
    expect(untitled.textContent).toContain(limit);
    await user.click(untitled);
    expect(composerTokens()).toHaveLength(3);
  });
});

describe("menu keys and the draft's identity", () => {
  it("↵ picks the active conversation row; Backspace through the @ closes without a token", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    await findComposerBox();
    typeComposer("@");
    let el = await menu();
    await within(el).findByRole("option", { name: /Quarterly plan/ });
    await within(el).findByText("report.pdf");
    // the files' row first, then the first conversation
    pressComposer("ArrowDown");
    pressComposer("Enter");
    expect(tokenOf("Quarterly plan")).toBeTruthy();
    expect(draftText()).toBe("@Quarterly plan ");
    typeComposer("@");
    el = await menu();
    await within(el).findByRole("option", { name: /Release notes/ });
    pressComposer("Backspace");
    backspaceComposer();
    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(draftText()).toBe("@Quarterly plan ");
    expect(composerTokens()).toHaveLength(1);
  });

  it("a resend keeps the clientMessageId; another set of references gets a new one", async () => {
    let n = 0;
    const calls = chatApi({
      [`POST ${BASE}/messages`]: () => {
        n += 1;
        return n < 3
          ? json(503, { error: { code: "unavailable", message: "try later" } })
          : json(202, { event: userMsg(9, "x") });
      },
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    await pick(user, /Release notes/);
    sendComposer("compare");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    await vi.waitFor(() => expect(composerTokens()).toHaveLength(2));
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    await vi.waitFor(() => expect(composerTokens()).toHaveLength(2));
    const id = (i: number) =>
      (bodyOf(posts(calls, `${BASE}/messages`)[i]) as { clientMessageId: string }).clientMessageId;
    expect(id(1)).toBe(id(0));
    // another reference makes another message (after a space: `@` right after a word is text)
    typeComposer(" ");
    await pick(user, /Quarterly review/);
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(3));
    expect(
      (bodyOf(posts(calls, `${BASE}/messages`)[2]) as { tokens: unknown[] }).tokens,
    ).toHaveLength(3);
    expect(id(2)).not.toBe(id(0));
  });
});

describe("refusedTokens (conversations)", () => {
  const draft = [
    "compare ",
    { kind: "conversation" as const, id: "c2", label: "Quarterly plan" },
    " ",
    { kind: "conversation" as const, id: "c3", label: "Untitled conversation" },
  ];
  const refused = (code: string, details: unknown[]) =>
    new ApiClientError(422, code, "refused", [], details);

  it("names the draft's refused tokens with their reason, in draft order", () => {
    expect(
      refusedTokens(
        refused("conversation.reference_unavailable", [
          { id: "c3", reason: "empty" },
          { id: "c2" },
        ]),
        draft,
      ),
    ).toEqual([
      { kind: "conversation", id: "c2", code: "conversation.reference_unavailable" },
      {
        kind: "conversation",
        id: "c3",
        code: "conversation.reference_unavailable",
        reason: "empty",
      },
    ]);
    expect(refusedTokens(refused("conversation.reference_self", [{ id: "c2" }]), draft)).toEqual([
      { kind: "conversation", id: "c2", code: "conversation.reference_self" },
    ]);
  });

  it("marks nothing for ids not in the draft or another error", () => {
    expect(
      refusedTokens(refused("conversation.reference_unavailable", [{ id: "x9" }]), draft),
    ).toEqual([]);
    expect(
      refusedTokens(refused("conversation.project_file_unavailable", [{ id: "c2" }]), draft),
    ).toEqual([]);
    expect(refusedTokens(new Error("boom"), draft)).toEqual([]);
  });
});

describe("a refused reference", () => {
  it.each(["zh", "en"] as const)(
    "marks each refused token and gives the draft back (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      chatApi({
        [`POST ${BASE}/messages`]: refusal("conversation.reference_unavailable", [
          { id: "c2" },
          { id: "c4", reason: "empty" },
        ]),
      });
      await renderChatRoute({ locale });
      await screen.findByText("hi");
      const user = userEvent.setup();
      await pick(user, /Quarterly plan/);
      await pick(user, /Release notes/);
      await pick(user, /Quarterly review/);
      sendComposer("compare");
      const copy = m.errors.conversation.reference_unavailable;
      const line = await refusalLine();
      // the line names the first refused token with its own copy
      expect(line.textContent).toContain("Quarterly plan");
      expect(line.textContent).toContain(copy.default);
      await vi.waitFor(() =>
        expect(tokenOf("Quarterly plan").getAttribute("data-state")).toBe("refused"),
      );
      expect(tokenOf("Release notes").getAttribute("data-state")).toBe("refused");
      expect(tokenOf("Quarterly review").getAttribute("data-state")).toBeNull();
      expect(draftText()).toContain("compare");
      // Remove takes the refused tokens out, the rest stays
      await user.click(
        within(line).getByRole("button", { name: locale === "zh" ? "移除" : "Remove" }),
      );
      await vi.waitFor(() => expect(composerTokens()).toHaveLength(1));
      expect(tokenOf("Quarterly review")).toBeTruthy();
    },
  );

  it("the conversation itself is marked with the self copy", async () => {
    chatApi({
      [`POST ${BASE}/messages`]: refusal("conversation.reference_self", [{ id: "c2" }]),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    sendComposer("compare");
    expect((await refusalLine()).textContent).toContain(en.errors.conversation.reference_self);
  });
});

describe("the bubble", () => {
  const quote = (id: string) => ({
    type: "text",
    text: `Referenced conversation: "Quarterly plan" (id ${id}; another conversation of this person)`,
  });

  it("shows content[0] as the text and an older message's references as links, never the quoted blocks", async () => {
    chatApi({}, [
      userMsg(1, "compare", {
        content: [{ type: "text", text: "compare" }, quote("c2"), quote("c3")],
        conversationRefs: [
          { id: "c2", title: "Quarterly plan", source: "summary", upToSeq: 30 },
          { id: "c3", title: null, source: "excerpt", upToSeq: 4 },
        ],
      }),
    ]);
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("compare");
    expect(screen.queryByText(/Referenced conversation/)).toBeNull();
    const link = screen.getByRole("link", { name: /Quarterly plan/ });
    expect(link.getAttribute("href")).toBe("/chat/c2");
    const untitled = screen.getByRole("link", { name: /未命名会话/ });
    expect(untitled.getAttribute("href")).toBe("/chat/c3");
  });

  it("Retry of a failed run sends the references again as tokens", async () => {
    const calls = chatApi(
      { [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(4, "compare") }) },
      [
        userMsg(1, "compare", {
          content: [{ type: "text", text: "compare" }, quote("c2")],
          conversationRefs: [{ id: "c2", title: "Quarterly plan", source: "excerpt", upToSeq: 3 }],
        }),
        runStarted(2),
        ev(3, "run_failed", { error: { code: "model.timeout", message: "x" } }),
      ],
    );
    await renderChatRoute();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({
      text: `compare ${MARK}`,
      retryOf: 1,
      tokens: [{ type: "conversation", id: "c2" }],
    });
  });
});

describe("a new conversation's first message", () => {
  const newRoutes = (extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) => ({
    [`GET ${ORG}/files/limits`]: () => json(200, LIMITS),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/devices`]: () => json(200, DEVICES),
    [`GET ${ORG}/devices/e1/projects`]: () =>
      json(200, { projects: [], hidden: 0, mode: "auto", base: "/Users/o", supported: true }),
    [`GET ${ORG}/conversation-permission-preview?deviceId=e1`]: () =>
      json(200, permissionPreview({ deviceId: "e1" })),
    [`GET ${ORG}/conversations/groups`]: () => json(200, { groups: [], next: null }),
    ...menuRoutes,
    ...extra,
  });

  it("carries the conversation token, every conversation offered (none is being written in)", async () => {
    resetNavigation("/");
    const r = newRoutes({
      [`POST ${ORG}/conversations/first-message`]: () =>
        json(201, { ...CONV("c9"), event: userMsg(1, "go"), events: [userMsg(1, "go")] }),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/", r);
    const user = userEvent.setup();
    await findComposerBox();
    typeComposer("@");
    const el = await menu();
    await within(el).findByRole("option", { name: /This conversation/ });
    await user.click(within(el).getByRole("option", { name: /Quarterly plan/ }));
    sendComposer("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(posts(calls, `${ORG}/conversations/first-message`)[0])).toMatchObject({
      message: { text: `${MARK} go`, tokens: [{ type: "conversation", id: "c2" }] },
    });
  });

  it("a refused create marks the token in the composer it comes back to", async () => {
    resetNavigation("/");
    const r = newRoutes({
      [`POST ${ORG}/conversations/first-message`]: refusal("conversation.reference_unavailable", [
        { id: "c2" },
      ]),
    });
    stubApi(r);
    await renderRouteWithCache("/", r);
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    sendComposer("go");
    const line = await refusalLine();
    expect(line.textContent).toContain(en.errors.conversation.reference_unavailable.default);
    await vi.waitFor(() =>
      expect(tokenOf("Quarterly plan").getAttribute("data-state")).toBe("refused"),
    );
    expect(draftText()).toBe("@Quarterly plan go");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
