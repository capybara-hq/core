import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { refusedConversationRefs } from "../src/components/conversation/ComposerBar";
import { ApiClientError } from "../src/lib/api";
import { bodyOf, type Call, json, stubApi } from "./support/api";
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
 * @ conversations (spec 2026-11-28 @ conversations §3, plan Task 3): the `@` menu's conversations
 * group lists the sender's conversations by title (never the one written in), a pick becomes a strip
 * chip and goes out as `conversationRefs` (the first message too), a refusal marks the refused
 * chips, and the bubble shows a logged message's references as link chips, never their quoted
 * blocks.
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

/** The routes the `@` menu reads besides the conversations: one library file, one resource. */
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

const input = (m = en) =>
  screen.getByRole("combobox", { name: m.chat.inputLabel, hidden: true }) as HTMLTextAreaElement;
const menu = async () => {
  await screen.findByRole("listbox");
  return document.querySelector('[data-part="composer-menu"]') as HTMLElement;
};
const headingsOf = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-part="composer-menu-label"]')].map((h) => h.textContent);
const strip = (m = en) => screen.getByRole("group", { name: m.chat.files });
/** Types `@`, waits for the conversations row named `name` and picks it. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string | RegExp, m = en) {
  await user.type(input(m), "@");
  const el = await menu();
  await user.click(await within(el).findByRole("option", { name }));
}
const refusal = (code: string, details: unknown[]) => () =>
  json(422, { error: { code, message: "refused", details } });

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
  it("lists my recent conversations after the files and before the resources, never this one", async () => {
    const calls = chatApi();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(zh), "@");
    const el = await menu();
    await within(el).findByRole("option", { name: /Quarterly plan/ });
    await within(el).findByText("Handbook");
    expect(headingsOf(el)).toEqual([
      zh.chat.composerMenu.recentFiles,
      zh.chat.composerMenu.conversations,
      "Docs",
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
    const user = userEvent.setup();
    await user.type(input(), "@");
    let el = await menu();
    await within(el).findByRole("option", { name: /Doc 0/ });
    expect(within(el).queryByRole("option", { name: /Doc 5/ })).toBeNull();
    await user.type(input(), "quarterly");
    await vi.waitFor(() => expect(listReads(calls)).toContain(`${LIST}?limit=9&q=quarterly`));
    el = await menu();
    await within(el).findByRole("option", { name: /Quarterly review/ });
    await vi.waitFor(() =>
      expect(within(el).queryByRole("option", { name: /Release notes/ })).toBeNull(),
    );
    // only the query the typing left is read
    expect(listReads(calls)).toEqual([`${LIST}?limit=9`, `${LIST}?limit=9&q=quarterly`]);
  });

  it("is not listed by + → File library or Connector resources", async () => {
    const calls = chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.library }));
    await within(await menu()).findByText("report.pdf");
    expect(listReads(calls)).toEqual([]);
  });

  it("a pick becomes a strip chip; the message carries conversationRefs and needs text", async () => {
    const calls = chatApi({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    expect(input().value).toBe("");
    const chip = within(strip()).getByText("Quarterly plan").closest('[data-part="attachment"]');
    expect(chip?.getAttribute("data-kind")).toBe("conversation");
    // a picked conversation is not offered again
    await user.type(input(), "@");
    const el = await menu();
    await within(el).findByRole("option", { name: /Release notes/ });
    expect(within(el).queryByRole("option", { name: /Quarterly plan/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.clear(input());
    expect((screen.getByRole("button", { name: en.chat.send }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(input().getAttribute("placeholder")).toBe(en.chat.referencesNeedText);
    await user.type(input(), "compare{Enter}");
    const post = posts(calls, `${BASE}/messages`);
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0])).toMatchObject({ text: "compare", conversationRefs: [{ id: "c2" }] });
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull());
  });

  it("the pending bubble shows the reference as a link chip", async () => {
    chatApi({ [`POST ${BASE}/messages`]: () => new Promise<Response>(() => {}) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    await user.type(input(), "compare{Enter}");
    const bubble = await vi.waitFor(() => {
      const el = document.querySelector("[data-pending]");
      if (!el) throw new Error("no pending bubble");
      return el as HTMLElement;
    });
    const link = within(bubble).getByRole("link", { name: /Quarterly plan/ });
    expect(link.getAttribute("href")).toBe("/chat/c2");
  });

  it("with three referenced the rows are disabled and say why", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    await pick(user, /Release notes/);
    await pick(user, /Quarterly review/);
    await user.type(input(), "@");
    const el = await menu();
    const untitled = await within(el).findByRole("option", {
      name: new RegExp(en.chat.composerMenu.untitledConversation),
    });
    const limit = en.chat.composerMenu.conversationLimit.replace("{max}", "3");
    expect(untitled.getAttribute("aria-disabled")).toBe("true");
    expect(untitled.textContent).toContain(limit);
    await user.click(untitled);
    expect(within(strip()).queryByText(en.chat.composerMenu.untitledConversation)).toBeNull();
  });
});

describe("menu keys and the draft's identity", () => {
  it("↵ picks the active conversation row; Backspace through the @ closes without a chip", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    let el = await menu();
    await within(el).findByRole("option", { name: /Quarterly plan/ });
    await within(el).findByText("Handbook");
    // the files' row first, then the first conversation
    await user.keyboard("{ArrowDown}{Enter}");
    expect(within(strip()).getByText("Quarterly plan")).toBeTruthy();
    expect(input().value).toBe("");
    await user.type(input(), "@");
    el = await menu();
    await within(el).findByRole("option", { name: /Release notes/ });
    await user.keyboard("{Backspace}");
    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(input().value).toBe("");
    expect(within(strip()).queryByText("Release notes")).toBeNull();
  });

  it("a chip's remove button removes it from the keyboard", async () => {
    chatApi();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await pick(user, /Quarterly plan/);
    within(strip())
      .getByRole("button", { name: /Quarterly plan/ })
      .focus();
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull());
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
    await user.type(input(), "compare{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    await vi.waitFor(() => expect(input().value).toBe("compare"));
    await user.type(input(), "{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    await vi.waitFor(() => expect(input().value).toBe("compare"));
    const id = (i: number) =>
      (bodyOf(posts(calls, `${BASE}/messages`)[i]) as { clientMessageId: string }).clientMessageId;
    expect(id(1)).toBe(id(0));
    await user.click(within(strip()).getByRole("button", { name: /Release notes/ }));
    await user.type(input(), "{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(3));
    expect(bodyOf(posts(calls, `${BASE}/messages`)[2])).toMatchObject({
      conversationRefs: [{ id: "c2" }],
    });
    expect(id(2)).not.toBe(id(0));
  });
});

describe("refusedConversationRefs", () => {
  const draft = [
    { id: "c2", title: "Quarterly plan" },
    { id: "c3", title: null },
  ];
  const refused = (code: string, details: unknown[]) =>
    new ApiClientError(422, code, "refused", [], details);

  it("names the draft's refused ids with their reason, in draft order", () => {
    expect(
      refusedConversationRefs(
        refused("conversation.reference_unavailable", [
          { id: "c3", reason: "empty" },
          { id: "c2" },
        ]),
        draft,
      ),
    ).toEqual([
      { id: "c2", why: "unavailable" },
      { id: "c3", why: "empty" },
    ]);
    expect(
      refusedConversationRefs(refused("conversation.reference_self", [{ id: "c2" }]), draft),
    ).toEqual([{ id: "c2", why: "self" }]);
  });

  it("marks nothing for ids not in the draft or another error", () => {
    expect(
      refusedConversationRefs(refused("conversation.reference_unavailable", [{ id: "x9" }]), draft),
    ).toEqual([]);
    expect(
      refusedConversationRefs(
        refused("conversation.project_file_unavailable", [{ id: "c2" }]),
        draft,
      ),
    ).toEqual([]);
    expect(refusedConversationRefs(new Error("boom"), draft)).toEqual([]);
  });
});

describe("a refused reference", () => {
  it.each(["zh", "en"] as const)(
    "marks each refused chip with its own copy and gives the draft back (%s)",
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
      await pick(user, /Quarterly plan/, m);
      await pick(user, /Release notes/, m);
      await pick(user, /Quarterly review/, m);
      await user.type(input(m), "compare{Enter}");
      const copy = m.errors.conversation.reference_unavailable;
      const back = await screen.findByRole("group", { name: m.chat.files });
      const chipOf = (title: string) =>
        within(back).getByText(title).closest('[data-part="attachment"]') as HTMLElement;
      await vi.waitFor(() => expect(chipOf("Quarterly plan").textContent).toContain(copy.default));
      expect(chipOf("Release notes").textContent).toContain(copy.empty);
      expect(chipOf("Quarterly review").getAttribute("data-state")).toBe("ready");
      expect(input(m).value).toBe("compare");
      // removing a refused chip takes its mark with it
      await user.click(
        within(chipOf("Quarterly plan")).getByRole("button", { name: /Quarterly plan/ }),
      );
      expect(within(back).queryByText("Quarterly plan")).toBeNull();
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
    await user.type(input(), "compare{Enter}");
    expect(
      await within(await screen.findByRole("group", { name: en.chat.files })).findByText(
        en.errors.conversation.reference_self,
      ),
    ).toBeTruthy();
  });
});

describe("the bubble", () => {
  const quote = (id: string) => ({
    type: "text",
    text: `Referenced conversation: "Quarterly plan" (id ${id}; another conversation of this person)`,
  });

  it("shows content[0] as the text and the references as links, never the quoted blocks", async () => {
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

  it("Retry of a failed run sends the references again", async () => {
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
      text: "compare",
      retryOf: 1,
      conversationRefs: [{ id: "c2" }],
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

  it("carries conversationRefs, every conversation offered (none is being written in)", async () => {
    resetNavigation("/");
    const r = newRoutes({
      [`POST ${ORG}/conversations/first-message`]: () =>
        json(201, { ...CONV("c9"), event: userMsg(1, "go"), events: [userMsg(1, "go")] }),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/", r);
    const user = userEvent.setup();
    await user.type(input(), "@");
    const el = await menu();
    await within(el).findByRole("option", { name: /This conversation/ });
    await user.click(within(el).getByRole("option", { name: /Quarterly plan/ }));
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(posts(calls, `${ORG}/conversations/first-message`)[0])).toMatchObject({
      message: { text: "go", conversationRefs: [{ id: "c2" }] },
    });
  });

  it("a refused create marks the chip in the composer it comes back to", async () => {
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
    await user.type(input(), "go{Enter}");
    const back = await screen.findByRole("group", { name: en.chat.files });
    expect(
      await within(back).findByText(en.errors.conversation.reference_unavailable.default),
    ).toBeTruthy();
    expect(input().value).toBe("go");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
