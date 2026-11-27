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

/**
 * Composer menus (spec 2026-11-28 composer menus §1–§4): ＋ opens a menu of what can be added or
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
const resourceReads = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === RESOURCES).map((c) => c.url);

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
    // the file library and project files join with their own lines; a disabled connector is absent
    expect(labelsOf(el)).toEqual([m.upload, m.resources, m.skills, "Docs", "CRM"]);
    expect(iconOf(within(el).getByRole("option", { name: m.upload }))).toBe("upload");
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
    await user.type(input(), "rep");
    await vi.waitFor(() => expect(resourceReads(calls)).toContain(`${RESOURCES}?query=rep`));
    el = await menu();
    await vi.waitFor(() => expect(labelsOf(el)).toEqual(["Report"]));
    // the query rested once: no read for the keys typed before
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

  it("an IME composition never opens it", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("hi");
    fireEvent.keyDown(input(), { key: "Process", keyCode: 229 });
    fireEvent.change(input(), { target: { value: "@", selectionStart: 1 } });
    noMenu();
    expect(input().value).toBe("@");
  });
});
