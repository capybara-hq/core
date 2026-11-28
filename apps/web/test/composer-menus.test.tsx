import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { stubWindowWidth } from "./support/width";

/**
 * Composer menus (spec 2026-11-28 composer menus §1–§4): + opens a menu of what can be added or
 * used, `/` lists skills and commands, `@` searches connector resources; one menu anchored to the
 * composer whose query is the text after the trigger, never the command palette.
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
const INVOCABLE = `${ORG}/agents/ag1/invocable-skills`;
const RESOURCES = `${ORG}/connectors/resources`;
const LIBRARY = `${ORG}/files`;

const SKILLS = {
  skills: [
    {
      id: "s1",
      name: "fix-issue",
      source: "platform",
      description: "Fix a GitHub issue",
      version: 1,
      argumentHint: "[issue-number]",
      manual: false,
      fork: false,
    },
    {
      id: "s2",
      name: "finish",
      source: "platform",
      description: "Wrap up the branch",
      version: 1,
      manual: false,
      fork: false,
    },
  ],
};

const connector = (over: Record<string, unknown>) => ({
  slug: "docs",
  connector: "mcp",
  endpoint: {},
  auth: { type: "none" },
  status: "active",
  setup: "ready",
  icon: null,
  description: null,
  git: null,
  gitPushPolicy: "ask",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});
const CONNECTORS = {
  connectors: [
    connector({
      id: "k1",
      name: "Docs",
      icon: "/api/v1/orgs/o1/connectors/k1/icon",
      description: "The handbook",
    }),
    connector({ id: "k2", name: "CRM", slug: "crm", setup: "needs_config" }),
    connector({ id: "k3", name: "Old", slug: "old", status: "disabled" }),
  ],
};

const resource = (connectorId: string, connectorName: string, name: string) => ({
  connectorId,
  connectorSlug: connectorName.toLowerCase(),
  connectorName,
  uri: `${connectorName.toLowerCase()}://${name.toLowerCase()}`,
  name,
});
const ALL_RESOURCES = [
  resource("k1", "Docs", "Handbook"),
  resource("k1", "Docs", "Report"),
  resource("k2", "CRM", "Accounts"),
];

const libraryFile = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  contentType: "application/pdf",
  size: 1024,
  origin: "upload",
  agentId: null,
  sourceConversation: null,
  versions: 1,
  createdAt: "2026-11-24T08:00:00Z",
  previewable: null,
  ...over,
});
const LIBRARY_FILES = [
  libraryFile("lf1", "report.pdf"),
  libraryFile("lf2", "notes.md", {
    contentType: "text/markdown",
    origin: "generated",
    agentId: "ag1",
    agentName: "Researcher",
    createdAt: "2026-11-20T08:00:00Z",
  }),
  libraryFile("lf3", "budget.xlsx"),
];
/** The library search route: the files whose name contains `q`. */
const librarySearch = (files: ReturnType<typeof libraryFile>[]) => (c: Call) => {
  const q = new URL(c.url, "http://x").searchParams.get("q") ?? "";
  return json(200, {
    files: files.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())),
    next: null,
  });
};

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/subagents`]: () => json(200, { subagents: [] }),
    [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
    [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
    [`GET ${ORG}/connectors`]: () => json(200, CONNECTORS),
    // no library files unless a test lists some (the `@` menu then shows resources alone)
    [`GET ${LIBRARY}`]: () => json(200, { files: [], next: null }),
    [`GET ${RESOURCES}`]: (c) => {
      const q = new URL(c.url, "http://x").searchParams.get("query") ?? "";
      return json(200, {
        resources: ALL_RESOURCES.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())),
        unavailable: [],
      });
    },
    ...extra,
  });
}

const input = (m = en) =>
  screen.getByRole("combobox", { name: m.chat.inputLabel, hidden: true }) as HTMLTextAreaElement;
const menu = async () => {
  await screen.findByRole("listbox");
  return document.querySelector('[data-part="composer-menu"]') as HTMLElement;
};
const noMenu = () => expect(screen.queryByRole("listbox")).toBeNull();
const headingsOf = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-part="composer-menu-label"]')].map((h) => h.textContent);
const labelsOf = (el: HTMLElement) =>
  within(el)
    .getAllByRole("option")
    .map((o) => o.querySelector(".cb-cmm-label")?.textContent);
const iconOf = (option: HTMLElement) =>
  option
    .querySelector('[data-part="composer-menu-lead"] [data-part="icon"]')
    ?.getAttribute("data-icon");
/** Types each character at the end of the draft, one change each, with no time between them. */
const typeAtEnd = (...chars: string[]) => {
  for (const c of chars) {
    const value = input().value + c;
    fireEvent.change(input(), { target: { value, selectionStart: value.length } });
  }
};
const resourceReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === RESOURCES).map((c) => c.url);
const libraryReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === LIBRARY).map((c) => c.url);

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

describe("the + menu", () => {
  it("lists Add, Abilities and the usable connectors; one waiting for setup is disabled", async () => {
    api();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    const plus = screen.getByRole("button", { name: "添加附件" });
    expect(plus.getAttribute("aria-haspopup")).toBe("menu");
    expect(plus.getAttribute("aria-expanded")).toBe("false");
    await user.click(plus);
    const el = await menu();
    expect(document.querySelector("[cmdk-root]")).toBeNull();
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    await within(el).findByText("Docs");
    const m = zh.chat.composerMenu;
    expect(headingsOf(el)).toEqual([m.add, m.abilities, m.connectors]);
    // project files join with a device project; a disabled connector is absent
    expect(labelsOf(el)).toEqual([m.upload, m.library, m.resources, m.skills, "Docs", "CRM"]);
    expect(iconOf(within(el).getByRole("option", { name: m.upload }))).toBe("upload");
    expect(iconOf(within(el).getByRole("option", { name: m.library }))).toBe("file-text");
    expect(iconOf(within(el).getByRole("option", { name: m.skills }))).toBe("skills");
    // a connector row carries its plugin's icon and its description
    const docs = within(el).getByRole("option", { name: "Docs" });
    expect(docs.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(
      "/api/v1/orgs/o1/connectors/k1/icon",
    );
    expect(docs.textContent).toContain("The handbook");
    const crm = within(el).getByRole("option", { name: `CRM ${m.needsConfig}` });
    expect(crm.getAttribute("aria-disabled")).toBe("true");
    // a second click on + closes it
    await user.click(plus);
    noMenu();
    // never the command palette (it stays for ⌘K)
    expect(document.querySelector("[cmdk-root]")).toBeNull();
  });

  it("Upload files opens the file picker and closes the menu", async () => {
    api();
    const { container } = await renderChatRoute();
    await screen.findByText("hi");
    const file = container.ownerDocument.querySelector(
      `input[type="file"][aria-label="${en.chat.addFiles}"]`,
    ) as HTMLInputElement;
    const click = vi.spyOn(file, "click");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.upload }));
    expect(click).toHaveBeenCalledTimes(1);
    noMenu();
  });

  it("Skills types / into the empty draft and opens the / menu", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.skills }));
    expect(input().value).toBe("/");
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("slash");
    await within(el).findByText("fix-issue");
  });

  it("a connector row opens @ for that connector alone", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("read");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: "Docs" }));
    expect(input().value).toBe("read @");
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("at");
    await within(el).findByText("Handbook");
    expect(headingsOf(el)).toEqual(["Docs"]);
    expect(within(el).queryByText("Accounts")).toBeNull();
    expect(resourceReads(calls)).toEqual([RESOURCES]);
  });
});

describe("the / menu", () => {
  it("filters inline from the text after the trigger; skills carry the skill icon, the command comes last", async () => {
    api({ [`POST ${BASE}/compact`]: () => json(202, { runId: "cr1" }) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    let el = await menu();
    await within(el).findByText("fix-issue");
    expect(labelsOf(el)).toEqual(["fix-issue", "finish", "compact"]);
    expect(iconOf(within(el).getByRole("option", { name: "fix-issue" }))).toBe("skills");
    expect(iconOf(within(el).getByRole("option", { name: "compact" }))).toBe("terminal");
    await user.type(input(), "fi");
    el = await menu();
    expect(labelsOf(el)).toEqual(["fix-issue", "finish"]);
    // the first ↵ picks the first skill, never the command
    await user.keyboard("{Enter}");
    expect(document.querySelector('[data-part="composer-token"]')?.textContent).toContain(
      "/fix-issue",
    );
    expect(input().value).toBe("");
    noMenu();
  });

  it("↑↓ move the active row and ↵ picks it without sending", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await within(await menu()).findByText("finish");
    await user.keyboard("{ArrowDown}");
    const active = document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
    expect(active?.querySelector(".cb-cmm-label")?.textContent).toBe("finish");
    await user.keyboard("{Enter}");
    expect(document.querySelector('[data-part="composer-token"]')?.textContent).toContain(
      "/finish",
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Backspace through the trigger closes; Esc closes and keeps the text", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await menu();
    await user.keyboard("{Backspace}");
    noMenu();
    expect(input().value).toBe("");
    await user.type(input(), "/fi");
    await menu();
    await user.keyboard("{Escape}");
    noMenu();
    expect(input().value).toBe("/fi");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("an IME composition's ↵ never picks", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    await within(await menu()).findByText("fix-issue");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(document.querySelector('[data-part="composer-token"]')).toBeNull();
    await menu();
  });
});

describe("the @ menu", () => {
  it("opens after whitespace, searches the kernel with the query (debounced) and attaches the pick", async () => {
    const calls = api({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @");
    let el = await menu();
    await within(el).findByText("Accounts");
    // grouped by connector, each row with its connector's mark
    expect(headingsOf(el)).toEqual(["Docs", "CRM"]);
    const handbook = within(el).getByRole("option", { name: "Handbook" });
    expect(handbook.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(
      "/api/v1/orgs/o1/connectors/k1/icon",
    );
    // three keys with no time between them: only the query they leave is read
    typeAtEnd("r", "e", "p");
    await vi.waitFor(() => expect(resourceReads(calls)).toContain(`${RESOURCES}?query=rep`));
    el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["Report"]));
    expect(resourceReads(calls)).toEqual([RESOURCES, `${RESOURCES}?query=rep`]);
    await user.keyboard("{Enter}");
    expect(input().value).toBe("see ");
    expect(screen.getByText("@Report")).toBeTruthy();
    await user.type(input(), "{Enter}");
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(bodyOf(post[0] as Call)).toMatchObject({
      text: "see",
      attachments: [{ connectorId: "k1", uri: "docs://report" }],
    });
  });

  it("a sixth resource is refused with the limit", async () => {
    const many = Array.from({ length: 6 }, (_, i) => resource("k1", "Docs", `Doc${i}`));
    api({
      [`GET ${RESOURCES}`]: () => json(200, { resources: many, unavailable: [] }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    for (let i = 0; i < 6; i++) {
      await user.type(input(), " @");
      await user.click(await screen.findByRole("option", { name: `Doc${i}` }));
    }
    expect(await screen.findByText(en.chat.attachLimit.replace("{max}", "5"))).toBeTruthy();
    expect(screen.queryByText("@Doc5")).toBeNull();
    expect(screen.getByText("@Doc4")).toBeTruthy();
  });

  it("a@b mid-word opens nothing; @ followed by a space closes", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "mail a@b");
    noMenu();
    await user.clear(input());
    await user.type(input(), "@");
    await menu();
    await user.type(input(), " ");
    noMenu();
    expect(input().value).toBe("@ ");
  });

  it("a key an IME commits directly (keyCode 229, no composition) opens it", async () => {
    api();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    // a Chinese IME's Shift+2: the key reports 229 and commits "@" with no composition
    fireEvent.keyDown(input(zh), { key: "Process", keyCode: 229 });
    fireEvent.change(input(zh), { target: { value: "@", selectionStart: 1 } });
    expect((await menu()).getAttribute("data-kind")).toBe("at");
  });

  it("a composition's intermediate text opens nothing; a composition committing @ does", async () => {
    api();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const el = input(zh);
    fireEvent.compositionStart(el, { data: "" });
    fireEvent.change(el, { target: { value: "@" } });
    fireEvent.change(el, { target: { value: "你" } });
    fireEvent.compositionEnd(el, { data: "你" });
    noMenu();
    fireEvent.change(el, { target: { value: "你 " } });
    fireEvent.compositionStart(el, { data: "" });
    fireEvent.change(el, { target: { value: "你 @" } });
    noMenu();
    fireEvent.compositionEnd(el, { data: "@" });
    expect((await menu()).getAttribute("data-kind")).toBe("at");
  });

  it("inside the menu an IME's intermediate text is not searched; what it commits is", async () => {
    const calls = api();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(zh), "@");
    const el = await menu();
    await within(el).findByText("Accounts");
    const field = input(zh);
    fireEvent.compositionStart(field, { data: "" });
    fireEvent.change(field, { target: { value: "@z" } });
    fireEvent.change(field, { target: { value: "@zh" } });
    // the pinyin is no query: the rows stay, nothing loads
    expect(labelsOf(await menu())).toEqual(["Handbook", "Report", "Accounts"]);
    expect(document.querySelector('[data-part="composer-menu-loading"]')).toBeNull();
    fireEvent.change(field, { target: { value: "@acc" } });
    fireEvent.compositionEnd(field, { data: "acc" });
    await vi.waitFor(() => expect(resourceReads(calls)).toContain(`${RESOURCES}?query=acc`));
    await vi.waitFor(async () => expect(labelsOf(await menu())).toEqual(["Accounts"]));
    expect(resourceReads(calls).filter((u) => u.includes("query=z"))).toEqual([]);
  });

  it("↵ before the query's results arrive picks among the rows that match it", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    await within(await menu()).findByText("Accounts");
    // typed and picked at once: the rows are still the empty query's
    typeAtEnd("a", "c", "c");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("@Accounts")).toBeTruthy();
    expect(screen.queryByText("@Handbook")).toBeNull();
    expect(input().value).toBe("");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Backspace through the @ closes it", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @");
    await menu();
    await user.keyboard("{Backspace}");
    noMenu();
    expect(input().value).toBe("see ");
  });

  it("a pick in the middle of the text leaves the caret where the trigger stood", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("ab later");
    await user.type(input(), "@", { initialSelectionStart: 3, initialSelectionEnd: 3 });
    expect(input().value).toBe("ab @later");
    await user.click(await screen.findByRole("option", { name: "Handbook" }));
    expect(input().value).toBe("ab later");
    expect(input().selectionStart).toBe(3);
    expect(input().selectionEnd).toBe(3);
  });

  it("draws at most 50 rows, also for one connector", async () => {
    const many = Array.from({ length: 60 }, (_, i) => resource("k1", "Docs", `Doc${i}`));
    api({ [`GET ${RESOURCES}`]: () => json(200, { resources: many, unavailable: [] }) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: "Docs" }));
    const el = await menu();
    await within(el).findByText("Doc0");
    expect(within(el).getAllByRole("option")).toHaveLength(50);
  });

  it("an unavailable connector's row says why when clicked", async () => {
    api({
      [`GET ${RESOURCES}`]: () =>
        json(200, {
          resources: [],
          unavailable: [{ connectorId: "k2", connectorName: "CRM", reason: "not_connected" }],
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    await user.click(await screen.findByRole("option", { name: /^CRM/ }));
    expect(
      await screen.findByText(
        en.chat.connectorUnavailableHint.not_connected.replace("{connector}", "CRM"),
      ),
    ).toBeTruthy();
    noMenu();
  });

  it("closes on a press outside the composer and keeps the text", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @");
    await menu();
    fireEvent.pointerDown(screen.getByText("hi"));
    noMenu();
    expect(input().value).toBe("see @");
  });
});

describe("the @ menu's library files", () => {
  const send = () => json(202, { event: userMsg(9, "x") });
  const posts = (calls: Call[]) =>
    calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
  const uploadsOrDiscards = (calls: Call[]) =>
    calls.filter(
      (c) =>
        (c.method === "POST" && c.url.split("?")[0] === LIBRARY) ||
        (c.method === "DELETE" && c.url.startsWith(`${LIBRARY}/`)),
    );

  it("lists 最近文件 first for the empty query, each with its type mark and when it came", async () => {
    api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(zh), "@");
    const el = await menu();
    await within(el).findByText("report.pdf");
    await within(el).findByText("Accounts");
    expect(headingsOf(el)).toEqual([zh.chat.composerMenu.recentFiles, "Docs", "CRM"]);
    const report = within(el).getByRole("option", { name: /report\.pdf/ });
    expect(report.querySelector('[data-part="composer-menu-lead"]')?.textContent).toBe("PDF");
    expect(report.textContent).toContain("2026-11-24 上传");
    const notes = within(el).getByRole("option", { name: /notes\.md/ });
    expect(notes.textContent).toContain("Researcher 2026-11-20 生成");
  });

  it("searches the library with q (debounced) under Matching files; a pick is sent by id, never uploaded", async () => {
    const calls = api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`POST ${BASE}/messages`]: send,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @");
    await within(await menu()).findByText("report.pdf");
    typeAtEnd("r", "e", "p");
    await vi.waitFor(() => expect(libraryReads(calls)).toContain(`${LIBRARY}?q=rep&limit=8`));
    expect(libraryReads(calls)).toEqual([`${LIBRARY}?limit=8`, `${LIBRARY}?q=rep&limit=8`]);
    let el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["report.pdf", "Report"]));
    el = await menu();
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.matchingFiles, "Docs"]);
    await user.click(within(el).getByRole("option", { name: /report\.pdf/ }));
    expect(input().value).toBe("see ");
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).getByText("report.pdf")).toBeTruthy();
    await user.type(input(), "{Enter}");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toMatchObject({ text: "see", files: ["lf1"] });
    expect(uploadsOrDiscards(calls)).toEqual([]);
  });

  it("the heading stays Recent files while @rep waits for its answer, then Matching files", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const calls = api({
      [`GET ${LIBRARY}`]: async (c) => {
        if (new URL(c.url, "http://x").searchParams.get("q") === "rep") await held;
        return librarySearch(LIBRARY_FILES)(c);
      },
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    await within(await menu()).findByText("report.pdf");
    expect(headingsOf(await menu())[0]).toBe(en.chat.composerMenu.recentFiles);
    typeAtEnd("r", "e", "p");
    await vi.waitFor(() => expect(libraryReads(calls)).toContain(`${LIBRARY}?q=rep&limit=8`));
    // the rows are still the empty query's: so is the heading
    expect(headingsOf(await menu())[0]).toBe(en.chat.composerMenu.recentFiles);
    release();
    await vi.waitFor(async () =>
      expect(headingsOf(await menu())[0]).toBe(en.chat.composerMenu.matchingFiles),
    );
    expect(labelsOf(await menu())[0]).toBe("report.pdf");
  });

  it("a file already in the draft is not added twice; removing one discards nothing", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    for (let i = 0; i < 2; i++) {
      await user.type(input(), "@");
      await user.click(await screen.findByRole("option", { name: /report\.pdf/ }));
    }
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).getAllByText("report.pdf")).toHaveLength(1);
    await user.click(within(group).getByRole("button", { name: /report\.pdf/ }));
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
    expect(uploadsOrDiscards(calls)).toEqual([]);
  });

  it("the per-message file count applies to library files", async () => {
    api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`GET ${LIBRARY}/limits`]: () =>
        json(200, {
          types: ["application/pdf"],
          maxBytes: 1_000_000,
          imageMaxBytes: 1_000_000,
          extensions: [],
          maxPerMessage: 2,
          requestMediaBytes: 10_000_000,
          available: true,
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    for (const name of [/report\.pdf/, /notes\.md/, /budget\.xlsx/]) {
      await user.type(input(), "@");
      await user.click(await screen.findByRole("option", { name }));
    }
    expect(await screen.findByText(en.chat.filesLimit.replace("{max}", "2"))).toBeTruthy();
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).queryByText("budget.xlsx")).toBeNull();
    expect(within(group).getByText("notes.md")).toBeTruthy();
  });

  it("+ → File library opens @ with the files alone", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.library }));
    expect(input().value).toBe("@");
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("at");
    await within(el).findByText("report.pdf");
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.recentFiles]);
    expect(within(el).queryByText("Handbook")).toBeNull();
    expect(resourceReads(calls)).toEqual([]);
  });

  it("+ → Connector resources lists no files", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.resources }));
    const el = await menu();
    await within(el).findByText("Handbook");
    expect(within(el).queryByText("report.pdf")).toBeNull();
    expect(libraryReads(calls)).toEqual([]);
  });

  it("a library file sent is read again: the next @ shows the library afresh", async () => {
    const calls = api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`POST ${BASE}/messages`]: send,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @");
    await user.click(await screen.findByRole("option", { name: /report\.pdf/ }));
    await user.type(input(), "{Enter}");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(libraryReads(calls)).toEqual([`${LIBRARY}?limit=8`]);
    await user.type(input(), "@");
    await within(await menu()).findByText("report.pdf");
    await vi.waitFor(() =>
      expect(libraryReads(calls)).toEqual([`${LIBRARY}?limit=8`, `${LIBRARY}?limit=8`]),
    );
  });

  it("a failed send gives a library file back; neither its failure, removal nor unmount discards it", async () => {
    const calls = api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`POST ${BASE}/messages`]: () =>
        json(404, {
          error: {
            code: "file.not_found",
            message: "gone",
            details: [{ path: "files", message: "gone", fileId: "lf1" }],
          },
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    for (const name of [/report\.pdf/, /notes\.md/]) {
      await user.type(input(), "@");
      await user.click(await screen.findByRole("option", { name }));
    }
    await user.type(input(), "see{Enter}");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    // given back with the failure marked on the file the kernel named
    const back = await screen.findByRole("group", { name: en.chat.files });
    expect((await within(back).findByRole("alert")).textContent).toBe(en.errors.file.not_found);
    expect(within(back).getByText("notes.md")).toBeTruthy();
    await user.click(within(back).getByRole("button", { name: /report\.pdf/ }));
    expect(within(back).queryByText("report.pdf")).toBeNull();
    cleanup();
    expect(uploadsOrDiscards(calls)).toEqual([]);
  });

  it("without storage the files are listed disabled, saying why", async () => {
    api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`GET ${LIBRARY}/limits`]: () =>
        json(200, {
          types: ["application/pdf"],
          maxBytes: 1_000_000,
          imageMaxBytes: 1_000_000,
          extensions: [],
          maxPerMessage: 10,
          requestMediaBytes: 10_000_000,
          available: false,
        }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    const el = await menu();
    await within(el).findByText("report.pdf");
    await vi.waitFor(() => {
      const row = within(el).getByRole("option", { name: /report\.pdf/ });
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.textContent).toContain(en.chat.filesUnavailable);
    });
    await user.click(within(el).getByRole("option", { name: /report\.pdf/ }));
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
  });

  it("failed resources keep the files and say so under them", async () => {
    api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`GET ${RESOURCES}`]: () =>
        json(500, { error: { code: "internal", message: "boom", requestId: "r1" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    const el = await menu();
    await within(el).findByText("report.pdf");
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.recentFiles]);
    await vi.waitFor(() =>
      expect(el.textContent).toContain(en.chat.composerMenu.resourcesFailed.split("{reason}")[0]),
    );
    expect(el.textContent).not.toContain(en.chat.composerMenu.libraryFailed.split("{reason}")[0]);
  });

  it("a failed library read keeps the resources and says so under them", async () => {
    api({
      [`GET ${LIBRARY}`]: () =>
        json(500, { error: { code: "internal", message: "boom", requestId: "r1" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "@");
    const el = await menu();
    await within(el).findByText("Accounts");
    expect(headingsOf(el)).toEqual(["Docs", "CRM"]);
    await vi.waitFor(() =>
      expect(el.textContent).toContain(en.chat.composerMenu.libraryFailed.split("{reason}")[0]),
    );
  });
});

describe("menu switches and edges", () => {
  it("+ over an open @ menu takes its trigger out of the text first", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "see @rep");
    await menu();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect((await menu()).getAttribute("data-kind")).toBe("plus");
    expect(input().value).toBe("see ");
  });

  it('+ → Connector resources over a draft adds " @" and opens @', async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("read");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.resources }));
    expect(input().value).toBe("read @");
    expect((await menu()).getAttribute("data-kind")).toBe("at");
  });

  it("a click on a connector waiting for setup does nothing", async () => {
    const calls = api();
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "添加附件" }));
    const el = await menu();
    await user.click(
      await within(el).findByRole("option", { name: `CRM ${zh.chat.composerMenu.needsConfig}` }),
    );
    expect((await menu()).getAttribute("data-kind")).toBe("plus");
    expect(input(zh).value).toBe("");
    expect(resourceReads(calls)).toEqual([]);
  });

  it("compact: the sheet's search field rewrites the text after the trigger", async () => {
    stubWindowWidth(390);
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("see ");
    fireEvent.change(input(), { target: { value: "see @", selectionStart: 5 } });
    const field = await screen.findByRole("searchbox", { name: en.chat.composerMenu.search });
    fireEvent.change(field, { target: { value: "rep" } });
    expect(input().value).toBe("see @rep");
    await vi.waitFor(() => expect(resourceReads(calls)).toContain(`${RESOURCES}?query=rep`));
    await user.click(await screen.findByRole("option", { name: "Report" }));
    expect(input().value).toBe("see ");
    expect(screen.getByText("@Report")).toBeTruthy();
  });
});
