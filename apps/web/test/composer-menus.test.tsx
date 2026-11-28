import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  backspaceComposer,
  composerTokens,
  draftText,
  pasteComposer,
  pressComposer,
  sendComposer,
  typeComposer,
} from "./support/composer";
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
 * Composer menus (spec 2026-11-28 composer menus §1–§4, composer inline tokens §4): + opens a menu
 * of what can be added or used, `/` lists skills and commands, `@` lists the agent's connectors,
 * the library's files and the sender's conversations, a connector's → opens its resources; one
 * menu anchored to the composer whose query is the text after the trigger, never the command
 * palette. Every pick is an inline token.
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

/** The agent's connectors as the `@` menu reads them (kernel `MentionableConnector`). */
const mentionable = (over: Record<string, unknown>) => ({
  slug: "docs",
  icon: null,
  state: "ready",
  credential: "none",
  toolCount: 2,
  resources: true,
  ...over,
});
const MENTIONABLE = {
  connectors: [
    mentionable({
      id: "k1",
      name: "Docs",
      icon: "/api/v1/orgs/o1/connectors/k1/icon",
      description: "The handbook",
    }),
    mentionable({ id: "k2", name: "CRM", slug: "crm", state: "needs_config", toolCount: 0 }),
  ],
};
const MENTIONABLE_URL = `${ORG}/agents/ag1/mentionable-connectors`;

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
    // no library files unless a test lists some (the `@` menu then shows the connectors alone)
    [`GET ${LIBRARY}`]: () => json(200, { files: [], next: null }),
    // no other conversations (the `@` menu's conversations group stays away)
    [`GET ${ORG}/conversations`]: () => json(200, { conversations: [], next: null }),
    [`GET ${MENTIONABLE_URL}`]: () => json(200, MENTIONABLE),
    // one connector's resources (the `@` menu's second level), searched by `query`
    [`GET ${RESOURCES}`]: (c) => {
      const u = new URL(c.url, "http://x");
      const q = u.searchParams.get("query") ?? "";
      const id = u.searchParams.get("connectorId");
      return json(200, {
        resources: ALL_RESOURCES.filter(
          (r) => r.connectorId === id && r.name.toLowerCase().includes(q.toLowerCase()),
        ),
        unavailable: [],
      });
    },
    ...extra,
  });
}

const input = (m = en) =>
  screen.getByRole("combobox", { name: m.chat.inputLabel, hidden: true }) as HTMLElement;
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
/** Empties the draft's text, character by character from its end. */
function clearComposer() {
  for (let i = draftText().length; i > 0 && draftText() !== ""; i--) backspaceComposer();
}
/** Opens a connector row's second level (its → button). */
const drill = async (el: HTMLElement, name: string) => {
  const row = await within(el).findByRole("option", { name: new RegExp(`^${name}`) });
  fireEvent.click(row.querySelector('[data-part="composer-menu-drill"]') as HTMLElement);
};
const levelTitle = () =>
  document.querySelector('[data-part="composer-menu-level"]')?.textContent ?? null;
const token = (name: string) => screen.queryByRole("img", { name });
const MARK = "\uFFFC";
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
  it("lists Add, Abilities and the agent's connectors; one waiting for setup is disabled", async () => {
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
    // project files join with a device project; resources are reached through their connector
    expect(labelsOf(el)).toEqual([m.upload, m.library, m.skills, "Docs", "CRM"]);
    expect(iconOf(within(el).getByRole("option", { name: m.upload }))).toBe("upload");
    expect(iconOf(within(el).getByRole("option", { name: m.library }))).toBe("file-text");
    expect(iconOf(within(el).getByRole("option", { name: m.skills }))).toBe("skills");
    // a connector row carries its icon, its description and the → to its resources
    const docs = within(el).getByRole("option", { name: /^Docs/ });
    expect(docs.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(
      "/api/v1/orgs/o1/connectors/k1/icon",
    );
    expect(docs.textContent).toContain("The handbook");
    expect(
      docs.querySelector('[data-part="composer-menu-drill"]')?.getAttribute("aria-label"),
    ).toBe(m.drill.replace("{name}", "Docs"));
    const crm = within(el).getByRole("option", { name: `CRM ${m.needsConfig}` });
    expect(crm.getAttribute("aria-disabled")).toBe("true");
    expect(crm.querySelector('[data-part="composer-menu-drill"]')).toBeNull();
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
    expect(draftText()).toBe("/");
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("slash");
    await within(el).findByText("fix-issue");
  });

  it("a connector row inserts its token at the caret", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    pasteComposer("read");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: /^Docs/ }));
    noMenu();
    expect(token("Connector: Docs")).not.toBeNull();
    expect(draftText()).toBe("read@Docs ");
    expect(resourceReads(calls)).toEqual([]);
  });

  it("a connector row's → types @ and opens that connector's resources", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    pasteComposer("read");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await drill(await menu(), "Docs");
    await vi.waitFor(() => expect(draftText()).toBe("read @"));
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("at");
    await within(el).findByText("Handbook");
    expect(levelTitle()).toContain(en.chat.composerMenu.resourcesHead.replace("{name}", "Docs"));
    expect(within(el).queryByText("Accounts")).toBeNull();
    expect(resourceReads(calls)).toEqual([`${RESOURCES}?connectorId=k1`]);
  });
});

describe("the / menu", () => {
  it("filters inline from the text after the trigger; skills carry the skill icon, the command comes last", async () => {
    api({ [`POST ${BASE}/compact`]: () => json(202, { runId: "cr1" }) });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("/");
    let el = await menu();
    await within(el).findByText("fix-issue");
    expect(labelsOf(el)).toEqual(["fix-issue", "finish", "compact"]);
    expect(iconOf(within(el).getByRole("option", { name: "fix-issue" }))).toBe("skills");
    expect(iconOf(within(el).getByRole("option", { name: "compact" }))).toBe("terminal");
    typeComposer("fi");
    el = await menu();
    expect(labelsOf(el)).toEqual(["fix-issue", "finish"]);
    // the first ↵ picks the first skill, never the command
    pressComposer("Enter");
    expect(token("Skill: /fix-issue")).not.toBeNull();
    expect(draftText()).toBe("/fix-issue ");
    noMenu();
  });

  it("↑↓ move the active row and ↵ picks it without sending", async () => {
    const calls = api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("/");
    await within(await menu()).findByText("finish");
    pressComposer("ArrowDown");
    const active = document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
    expect(active?.querySelector(".cb-cmm-label")?.textContent).toBe("finish");
    pressComposer("Enter");
    expect(token("Skill: /finish")).not.toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("opens after whitespace too; with a skill token the others are disabled and no command shows", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("please /");
    let el = await menu();
    await within(el).findByText("fix-issue");
    // a `/` that is not the whole draft offers no command
    expect(within(el).queryByRole("option", { name: "compact" })).toBeNull();
    pressComposer("Enter");
    typeComposer("now /");
    el = await menu();
    const finish = await within(el).findByRole("option", { name: /^finish/ });
    expect(finish.getAttribute("aria-disabled")).toBe("true");
    expect(finish.textContent).toContain(en.chat.composerMenu.oneSkill);
  });

  it("Backspace through the trigger closes; Esc closes and keeps the text", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("/");
    await menu();
    pressComposer("Backspace");
    noMenu();
    clearComposer();
    typeComposer("/fi");
    await menu();
    pressComposer("Escape");
    noMenu();
    expect(draftText()).toBe("/fi");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("an IME composition's ↵ never picks", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("/");
    await within(await menu()).findByText("fix-issue");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(composerTokens()).toHaveLength(0);
    await menu();
  });
});

describe("the @ menu", () => {
  it("opens after whitespace, lists the agent's connectors filtered by the query and inserts the pick", async () => {
    const calls = api({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("see @");
    let el = await menu();
    await within(el).findByRole("option", { name: /^Docs/ });
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.connectorsGroup]);
    const docs = within(el).getByRole("option", { name: /^Docs/ });
    expect(docs.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(
      "/api/v1/orgs/o1/connectors/k1/icon",
    );
    // the connectors are read once per agent and filtered in the browser; no resource is read
    typeComposer("cr");
    el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["CRM"]));
    clearComposer();
    typeComposer("see @do");
    el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["Docs"]));
    expect(calls.filter((c) => c.url === MENTIONABLE_URL)).toHaveLength(1);
    expect(resourceReads(calls)).toEqual([]);
    pressComposer("Enter");
    expect(draftText()).toBe("see @Docs ");
    expect(token("Connector: Docs")).not.toBeNull();
    pressComposer("Enter");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)).toHaveLength(
        1,
      ),
    );
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(bodyOf(post[0] as Call)).toMatchObject({
      text: `see ${MARK}`,
      tokens: [{ type: "connector", connectorId: "k1" }],
    });
  });

  it("→ opens a connector's resources: the query goes, the @ stays, typing searches them", async () => {
    const calls = api({
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("see @do");
    await within(await menu()).findByRole("option", { name: /^Docs/ });
    pressComposer("ArrowRight");
    await vi.waitFor(() => expect(draftText()).toBe("see @"));
    let el = await menu();
    await within(el).findByText("Handbook");
    expect(levelTitle()).toContain("Docs · Resources");
    const handbook = within(el).getByRole("option", { name: /^Handbook/ });
    expect(handbook.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(
      "/api/v1/orgs/o1/connectors/k1/icon",
    );
    // three keys with no time between them: only the query they leave is read
    typeComposer("rep");
    await vi.waitFor(() =>
      expect(resourceReads(calls)).toContain(`${RESOURCES}?connectorId=k1&query=rep`),
    );
    el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["Report"]));
    expect(resourceReads(calls)).toEqual([
      `${RESOURCES}?connectorId=k1`,
      `${RESOURCES}?connectorId=k1&query=rep`,
    ]);
    pressComposer("Enter");
    expect(draftText()).toBe("see @Report ");
    expect(token("Resource: Report")).not.toBeNull();
    pressComposer("Enter");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)).toHaveLength(
        1,
      ),
    );
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(bodyOf(post[0] as Call)).toMatchObject({
      text: `see ${MARK}`,
      tokens: [{ type: "resource", connectorId: "k1", uri: "docs://report" }],
    });
  });

  it("Backspace on the second level's empty query goes back and keeps the @", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("@do");
    await within(await menu()).findByRole("option", { name: /^Docs/ });
    pressComposer("ArrowRight");
    await within(await menu()).findByText("Handbook");
    pressComposer("Backspace");
    await vi.waitFor(() => expect(levelTitle()).toBeNull());
    await within(await menu()).findByRole("option", { name: /^Docs/ });
    expect(draftText()).toBe("@");
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
      typeComposer(" @");
      await drill(await menu(), "Docs");
      await user.click(await screen.findByRole("option", { name: new RegExp(`^Doc${i}`) }));
    }
    expect(await screen.findByText(en.chat.tokenLimit.replace("{max}", "5"))).toBeTruthy();
    expect(token("Resource: Doc5")).toBeNull();
    expect(token("Resource: Doc4")).not.toBeNull();
  });

  it("a@b mid-word opens nothing; @ followed by a space closes", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("mail a@b");
    noMenu();
    clearComposer();
    typeComposer("@");
    await menu();
    typeComposer(" ");
    noMenu();
    expect(draftText()).toBe("@ ");
  });

  it("↵ before the query's results arrive picks among the rows that match it", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("@");
    await within(await menu()).findByText("budget.xlsx");
    // typed and picked at once: the file rows are still the empty query's
    typeComposer("bud");
    pressComposer("Enter");
    expect(token("File: budget.xlsx")).not.toBeNull();
    expect(token("File: report.pdf")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Backspace through the @ closes it", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("see @");
    await menu();
    pressComposer("Backspace");
    noMenu();
  });

  it("draws at most 50 resource rows", async () => {
    const many = Array.from({ length: 60 }, (_, i) => resource("k1", "Docs", `Doc${i}`));
    api({ [`GET ${RESOURCES}`]: () => json(200, { resources: many, unavailable: [] }) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await drill(await menu(), "Docs");
    const el = await menu();
    await within(el).findByText("Doc0");
    expect(within(el).getAllByRole("option")).toHaveLength(50);
  });

  it("a connector the sender has not connected says why in its second level", async () => {
    api({
      [`GET ${RESOURCES}`]: () =>
        json(403, { error: { code: "credential.missing", message: "not connected" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("@");
    await drill(await menu(), "Docs");
    const reason = en.errors.credential.missing as string;
    const el = await menu();
    await vi.waitFor(() =>
      expect(el.textContent).toContain(
        en.chat.composerMenu.resourcesFailed.replace("{reason}", reason),
      ),
    );
  });

  it("closes on a press outside the composer and keeps the text", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("see @");
    await menu();
    fireEvent.pointerDown(screen.getByText("hi"));
    noMenu();
    expect(draftText()).toBe("see @");
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

  it("lists 最近文件 after the connectors for the empty query, each with its type mark and when it came", async () => {
    api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    typeComposer("@", input(zh));
    const el = await menu();
    await within(el).findByText("report.pdf");
    await within(el).findByText("Docs");
    expect(headingsOf(el)).toEqual([
      zh.chat.composerMenu.connectorsGroup,
      zh.chat.composerMenu.recentFiles,
    ]);
    const report = within(el).getByRole("option", { name: /report\.pdf/ });
    expect(report.querySelector('[data-part="composer-menu-lead"]')?.textContent).toBe("PDF");
    expect(report.textContent).toContain("2026-11-24 上传");
    const notes = within(el).getByRole("option", { name: /notes\.md/ });
    expect(notes.textContent).toContain("Researcher 2026-11-20 生成");
  });

  it("searches the library with q (debounced) under Matching files; a pick is a token sent by id, never uploaded", async () => {
    const calls = api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`POST ${BASE}/messages`]: send,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("see @");
    await within(await menu()).findByText("report.pdf");
    typeComposer("rep");
    await vi.waitFor(() => expect(libraryReads(calls)).toContain(`${LIBRARY}?q=rep&limit=8`));
    expect(libraryReads(calls)).toEqual([`${LIBRARY}?limit=8`, `${LIBRARY}?q=rep&limit=8`]);
    let el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["report.pdf"]));
    el = await menu();
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.matchingFiles]);
    await user.click(within(el).getByRole("option", { name: /report\.pdf/ }));
    expect(draftText()).toBe("see @report.pdf ");
    expect(token("File: report.pdf")).not.toBeNull();
    // a library file is a token in the sentence, never a card in the strip
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).toMatchObject({
      text: `see ${MARK}`,
      tokens: [{ type: "file", id: "lf1" }],
    });
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
    typeComposer("@");
    await within(await menu()).findByText("report.pdf");
    expect(headingsOf(await menu())).toContain(en.chat.composerMenu.recentFiles);
    typeComposer("rep");
    await vi.waitFor(() => expect(libraryReads(calls)).toContain(`${LIBRARY}?q=rep&limit=8`));
    // the rows are still the empty query's: so is the heading
    expect(headingsOf(await menu())).toContain(en.chat.composerMenu.recentFiles);
    release();
    await vi.waitFor(async () =>
      expect(headingsOf(await menu())).toContain(en.chat.composerMenu.matchingFiles),
    );
    expect(labelsOf(await menu())[0]).toBe("report.pdf");
  });

  it("removing a picked library file's token discards nothing", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("@");
    await user.click(await screen.findByRole("option", { name: /report\.pdf/ }));
    expect(token("File: report.pdf")).not.toBeNull();
    // the space after the token, then the token as one unit
    backspaceComposer();
    pressComposer("Backspace");
    await vi.waitFor(() => expect(token("File: report.pdf")).toBeNull());
    expect(uploadsOrDiscards(calls)).toEqual([]);
  });

  it("+ → File library opens @ with the files alone", async () => {
    const calls = api({ [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES) });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await user.click(await screen.findByRole("option", { name: en.chat.composerMenu.library }));
    await vi.waitFor(() => expect(draftText()).toBe("@"));
    const el = await menu();
    expect(el.getAttribute("data-kind")).toBe("at");
    await within(el).findByText("report.pdf");
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.recentFiles]);
    expect(within(el).queryByText("Docs")).toBeNull();
    expect(resourceReads(calls)).toEqual([]);
  });

  it("a library file token sent leaves the library's listing as it was (only uploads add to it)", async () => {
    const calls = api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`POST ${BASE}/messages`]: send,
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("see @");
    await user.click(await screen.findByRole("option", { name: /report\.pdf/ }));
    pressComposer("Enter");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(bodyOf(posts(calls)[0])).not.toHaveProperty("files");
    await vi.waitFor(() => expect(draftText()).toBe(""));
    typeComposer("@");
    await within(await menu()).findByText("report.pdf");
    // the cached listing serves the next @: nothing sent was new to the library
    expect(libraryReads(calls)).toEqual([`${LIBRARY}?limit=8`]);
  });

  it("a refused library file is marked in the draft given back; its removal discards nothing", async () => {
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
      typeComposer("@");
      await user.click(await screen.findByRole("option", { name }));
    }
    sendComposer("see");
    await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
    // given back with the refusal marked on the file the kernel named
    const line = await vi.waitFor(() => {
      const el = [...document.querySelectorAll('[data-part="callout"]')].find(
        (c) => c.getAttribute("data-tone") === "fail",
      );
      if (!el) throw new Error("no refusal line");
      // the editor draws the restored draft's tokens after the line (it applies a draft the page
      // sets in an effect, then renders its tokens): wait for a refused token too
      if (!document.querySelector('[data-part="inline-token"][data-state="refused"]'))
        throw new Error("no refused token drawn yet");
      return el as HTMLElement;
    });
    expect(line.textContent).toContain(`report.pdf can't be used: ${en.errors.file.not_found}`);
    expect(token("File: report.pdf, unavailable")).not.toBeNull();
    expect(token("File: notes.md")).not.toBeNull();
    await user.click(within(line).getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(token("File: report.pdf, unavailable")).toBeNull());
    expect(token("File: notes.md")).not.toBeNull();
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
    typeComposer("@");
    const el = await menu();
    await within(el).findByText("report.pdf");
    await vi.waitFor(() => {
      const row = within(el).getByRole("option", { name: /report\.pdf/ });
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.textContent).toContain(en.chat.filesUnavailable);
    });
    await user.click(within(el).getByRole("option", { name: /report\.pdf/ }));
    expect(composerTokens()).toHaveLength(0);
  });

  it("failed connectors keep the files and say so under them", async () => {
    api({
      [`GET ${LIBRARY}`]: librarySearch(LIBRARY_FILES),
      [`GET ${MENTIONABLE_URL}`]: () =>
        json(500, { error: { code: "internal", message: "boom", requestId: "r1" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("@");
    const el = await menu();
    await within(el).findByText("report.pdf");
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.recentFiles]);
    await vi.waitFor(() =>
      expect(el.textContent).toContain(en.chat.composerMenu.connectorsFailed.split("{reason}")[0]),
    );
    expect(el.textContent).not.toContain(en.chat.composerMenu.libraryFailed.split("{reason}")[0]);
  });

  it("a failed library read keeps the connectors and says so under them", async () => {
    api({
      [`GET ${LIBRARY}`]: () =>
        json(500, { error: { code: "internal", message: "boom", requestId: "r1" } }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    typeComposer("@");
    const el = await menu();
    await within(el).findByText("Docs");
    expect(headingsOf(el)).toEqual([en.chat.composerMenu.connectorsGroup]);
    await vi.waitFor(() =>
      expect(el.textContent).toContain(en.chat.composerMenu.libraryFailed.split("{reason}")[0]),
    );
  });
});

describe("menu switches and edges", () => {
  it("+ over an open @ menu opens the + menu; the typed @ stays as text", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("see @rep");
    await menu();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect((await menu()).getAttribute("data-kind")).toBe("plus");
    expect(draftText()).toBe("see @rep");
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
    expect(draftText(input(zh))).toBe("");
    expect(resourceReads(calls)).toEqual([]);
  });

  it("compact: the sheet's search field rewrites the text after the trigger", async () => {
    stubWindowWidth(390);
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("see @");
    const field = await screen.findByRole("searchbox", { name: en.chat.composerMenu.search });
    fireEvent.change(field, { target: { value: "do" } });
    await vi.waitFor(() => expect(draftText()).toBe("see @do"));
    await user.click(await screen.findByRole("option", { name: /^Docs/ }));
    expect(draftText()).toBe("see @Docs ");
    expect(token("Connector: Docs")).not.toBeNull();
  });
});
