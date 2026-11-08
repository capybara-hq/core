import {
  DesignProvider,
  type LinkComponent,
  Sidebar,
  type SidebarProps,
} from "@capybara-hq/design";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { useConversationGroups } from "../src/components/shell/conversations";
import type { AgentProfile } from "../src/lib/agents";
import { agentsQuery } from "../src/lib/query/agents";
import { conversationGroupsQuery } from "../src/lib/query/shell";
import { bodyOf, json, stubApi } from "./support/api";
import {
  CONV,
  ENVIRONMENTS,
  envView,
  FakeEventSource,
  LIMITS,
  MODELS,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { Link, resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache, testQueryClient } from "./support/query";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => ({ conversationId: "c1" }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";

const agent = (id: string, name: string, profile: Partial<AgentProfile> = {}) => ({
  id,
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 1,
  definition: {
    name,
    instructions: "x",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
  },
  profile: {
    avatar: { kind: "preset", id: "fox" },
    description: "",
    quickActions: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...profile,
  },
  updatedAt: "2026-10-26T06:00:00.000Z",
});

const qa = (title: string) => ({ title, body: `${title} body` });

/** Seven agents: Beta and Alpha were talked to last (in that order), the rest go by name. */
const AGENTS = {
  agents: [
    agent("ag1", "Alpha", { quickActions: [qa("Summarize"), qa("Translate")] }),
    agent("ag2", "Beta", {
      quickActions: [qa("Plan"), qa("Review"), qa("Draft"), qa("Polish"), qa("Ship")],
    }),
    agent("ag3", "Gamma"),
    agent("ag4", "Delta"),
    agent("ag5", "Epsilon"),
    agent("ag6", "Zeta"),
    agent("ag7", "Eta"),
  ],
};

const group = (id: string, name: string, latestAt: string) => ({
  agent: { id, name },
  latestAt,
  conversations: [],
  more: false,
});
const GROUPS = {
  groups: [
    group("ag2", "Beta", "2026-11-03T08:00:00.000Z"),
    group("ag1", "Alpha", "2026-11-02T08:00:00.000Z"),
  ],
  next: null,
};

const routes = (agents: unknown = AGENTS, groups: unknown = GROUPS) => ({
  [`GET ${ORG}/attachments/limits`]: () => json(200, LIMITS),
  [`GET ${ORG}/agents`]: () => json(200, agents),
  [`GET ${ORG}/models`]: () => json(200, MODELS),
  [`GET ${ORG}/environments`]: () => json(200, ENVIRONMENTS),
  [`GET ${ORG}/conversations/groups`]: () => json(200, groups),
});

const input = () => screen.getByRole("textbox", { name: en.chat.inputLabel, hidden: true });
const row = () => screen.queryByRole("group", { name: "Choose an agent" });
/** The quick actions: a zap button in the composer's control row (spec §6.16.27). */
const quick = () => screen.queryByRole("button", { name: "Common tasks" });
/** Opens the quick actions menu and reads its titles, then closes it with Escape. */
async function titles(user: ReturnType<typeof userEvent.setup>) {
  await user.click(quick() as HTMLElement);
  const menu = await screen.findByRole("menu", { name: "Common tasks" });
  const out = within(menu)
    .getAllByRole("menuitem")
    .map((b) => b.textContent);
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return out;
}
/** Picks a quick action from the zap menu. */
async function pick(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(quick() as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: title }));
}

beforeEach(() => {
  resetNavigation("/");
  vi.stubGlobal("EventSource", FakeEventSource);
  // 09:00 local: the morning set; the first line of it
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0));
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("the new conversation page (agent profile design §4)", () => {
  it("the page shows a greeting for the bucket, the agents row and the first agent's quick actions", async () => {
    expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/", routes());
    // picked after mount: the morning's first line with the person's name
    expect(
      await screen.findByRole("heading", {
        name: String(en.chat.greeting.morning[0]).replace("{name}", "Grant"),
      }),
    ).toBeTruthy();
    expect(screen.getByText(en.chat.greeting.sub)).toBeTruthy();
    // most recent conversation per agent first, then by name; 5 then More +2
    const chips = within(row() as HTMLElement).getAllByRole("button");
    expect(chips.map((c) => c.textContent?.trim())).toEqual([
      "Beta",
      "Alpha",
      "Delta",
      "Epsilon",
      "Eta",
      "More +2",
    ]);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    // Beta's quick actions: a zap button right after the effort picker, its menu lists all five
    const bar = container.querySelector('[data-part="composer-bar"]') as HTMLElement;
    expect(bar.contains(quick())).toBe(true);
    const parts = [...bar.children].map((e) => e.getAttribute("data-part"));
    // after the pickers (640 and up) and the options button that stands for them on a phone
    expect(parts.slice(parts.indexOf("quick-actions") - 2, parts.indexOf("quick-actions"))).toEqual(
      ["composer-pickers", "composer-options"],
    );
    expect(await titles(userEvent.setup())).toEqual(["Plan", "Review", "Draft", "Polish", "Ship"]);
    // the composer has no agent picker; the model picker stays
    expect(bar.textContent).not.toContain("Beta");
    expect(input().getAttribute("placeholder")).toBe("What should Beta do?");
    // top to bottom: greeting, agents, composer (no line of quick actions between them)
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    expect(body.querySelector('[data-part="quick-action"]')).toBeNull();
    const order = [body.querySelector("h2"), row(), input()] as HTMLElement[];
    for (let i = 1; i < order.length; i++) {
      expect(
        (order[i - 1] as HTMLElement).compareDocumentPosition(order[i] as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("the model and effort menus carry no 'from the next message' note: nothing was sent yet", async () => {
    const { container } = await renderRouteWithCache("/", routes());
    await screen.findByRole("heading", {
      name: String(en.chat.greeting.morning[0]).replace("{name}", "Grant"),
    });
    const bar = container.querySelector('[data-part="composer-bar"]') as HTMLElement;
    const model = await within(bar).findByRole("button", {
      name: new RegExp(`^${en.chat.pickModel}: `),
    });
    await userEvent.setup().click(model);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(screen.queryByText(en.chat.nextMessage)).toBeNull();
  });

  it("selecting another agent switches the quick actions and the composer's agent", async () => {
    const calls = stubApi({
      [`POST ${ORG}/conversations`]: () =>
        json(201, { ...CONV("c9", { agentId: "ag1" }), event: userMsg(1, "go") }),
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.click(within(row() as HTMLElement).getByRole("button", { name: "Alpha" }));
    expect(input().getAttribute("placeholder")).toBe("What should Alpha do?");
    // the composer takes the focus, ready to type
    expect(document.activeElement).toBe(input());
    expect(await titles(user)).toEqual(["Summarize", "Translate"]);
    // an agent with no quick actions has no zap button; one picked in the panel focuses the composer
    await user.click(within(row() as HTMLElement).getByRole("button", { name: "More +2" }));
    await user.click(await screen.findByRole("option", { name: /Gamma/ }));
    expect(quick()).toBeNull();
    expect(input().getAttribute("placeholder")).toBe("What should Gamma do?");
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(document.activeElement).toBe(input());
    // the send goes to the selected agent
    await user.click(within(row() as HTMLElement).getByRole("button", { name: "Alpha" }));
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ agentId: "ag1" });
  });

  it("while the agents load, the row draws placeholder chips and nothing is interactive", async () => {
    const { container } = await renderRouteEmptyCache("/", {
      ...routes(),
      [`GET ${ORG}/agents`]: () => new Promise<Response>(() => {}),
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-part="agent-row"][data-loading="true"]')).toBeTruthy(),
    );
    const loading = container.querySelector('[data-part="agent-row"][data-loading="true"]');
    expect(loading?.querySelectorAll('[data-part="agent-chip"]').length).toBe(3);
    expect(within(loading as HTMLElement).queryAllByRole("button")).toEqual([]);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("one usable agent: no row", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache(
      "/",
      routes({ agents: [AGENTS.agents[0]] }, { groups: [], next: null }),
    );
    await screen.findByRole("heading", { name: /Grant/ });
    expect(row()).toBeNull();
    // nothing to choose: the line under the greeting names the agent instead of "pick one"
    expect(screen.getByText("Start a conversation with Alpha")).toBeTruthy();
    expect(screen.queryByText(en.chat.greeting.sub)).toBeNull();
    expect(await titles(userEvent.setup())).toEqual(["Summarize", "Translate"]);
    expect(input().getAttribute("placeholder")).toBe("What should Alpha do?");
  });

  it("picking a quick action fills the composer; ⌘Z restores the previous text", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.type(input(), "my draft");
    await pick(user, "Review");
    expect(input()).toHaveProperty("value", "Review body");
    // the menu closes and leaves the focus in the composer it filled
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    // one undo step: the previous text comes back, and a second ⌘Z is the browser's own
    fireEvent.keyDown(input(), { key: "z", metaKey: true });
    expect(input()).toHaveProperty("value", "my draft");
    const again = fireEvent.keyDown(input(), { key: "z", metaKey: true });
    expect(again).toBe(true);
    expect(input()).toHaveProperty("value", "my draft");
    // Ctrl+Z too; an edit after the pick leaves ⌘Z to the browser
    await pick(user, "Plan");
    expect(input()).toHaveProperty("value", "Plan body");
    fireEvent.keyDown(input(), { key: "z", ctrlKey: true });
    expect(input()).toHaveProperty("value", "my draft");
    await pick(user, "Plan");
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    await user.type(input(), "!");
    expect(fireEvent.keyDown(input(), { key: "z", metaKey: true })).toBe(true);
    expect(input()).toHaveProperty("value", "Plan body!");
  });

  it("an agent with avatar null shows its initial in the row, the cards, title bar and sidebar", async () => {
    const plain = {
      agents: [
        agent("ag1", "echo agent", { avatar: null }),
        agent("ag2", "Beta", { avatar: { kind: "preset", id: "owl" } }),
      ],
    };
    const initialIn = (el: Element | null) =>
      el?.querySelector('[data-part="avatar"][data-kind="initial"]')?.textContent;
    // the new conversation's agents row (24)
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/", routes(plain, { groups: [], next: null }));
    const chip = within(row() as HTMLElement).getByRole("button", { name: "echo agent" });
    expect(initialIn(chip)).toBe("E");
    expect(
      within(row() as HTMLElement)
        .getByRole("button", { name: "Beta" })
        .querySelector('[data-part="avatar"]')
        ?.getAttribute("data-preset"),
    ).toBe("owl");
    cleanup();

    // the agent cards (40, ruling P4-15)
    await renderRouteWithCache("/agents", {
      [`GET ${ORG}/agents`]: () => json(200, plain),
      [`GET ${ORG}/members`]: () => json(200, { members: [] }),
      [`GET ${ORG}/agent-templates`]: () => json(200, { templates: [] }),
      [`GET ${ORG}/components`]: () => json(200, { components: [] }),
    });
    const listRow = screen.getByText("echo agent").closest("li");
    expect(initialIn(listRow)).toBe("E");
    expect(listRow?.querySelector('[data-part="avatar"]')?.getAttribute("data-size")).toBe("40");
    cleanup();

    // the conversation title bar, next to the agent name (16)
    stubApi({
      [`GET ${ORG}/conversations/c1`]: () => json(200, CONV("c1")),
      [`GET ${ORG}/conversations/c1/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${ORG}/agents`]: () => json(200, plain),
    });
    const { container } = await renderChatRoute({ locale: "en" });
    await screen.findByText("hi");
    const nav = within(container.querySelector('[data-part="title-bar"]') as HTMLElement).getByRole(
      "navigation",
      { name: "Path" },
    );
    const link = within(nav).getByRole("link", { name: "echo agent" });
    expect(initialIn(link)).toBe("E");
    expect(link.querySelector('[data-part="avatar"]')?.getAttribute("data-size")).toBe("16");
    cleanup();

    // the sidebar group titles (16), from the cached agents; a group with no cached agent: its name
    const client = testQueryClient();
    client.setQueryData(agentsQuery("o1").queryKey, plain);
    client.setQueryData(conversationGroupsQuery("o1").queryKey, {
      groups: [
        { ...group("ag1", "echo agent", "2026-11-03T08:00:00.000Z") },
        { ...group("ag2", "Beta", "2026-11-02T08:00:00.000Z") },
        { ...group("ag9", "gone agent", "2026-11-01T08:00:00.000Z") },
      ].map((g) => ({
        ...g,
        conversations: [
          {
            id: `c-${g.agent.id}`,
            orgId: "o1",
            agentId: g.agent.id,
            title: "t",
            lastSeq: 1,
            createdAt: "2026-10-20T06:32:00.000Z",
            updatedAt: "2026-10-20T06:32:00.000Z",
          },
        ],
      })),
      next: null,
    });
    stubApi({ [`GET ${ORG}/conversations/groups`]: () => new Promise<Response>(() => {}) });
    render(
      <QueryClientProvider client={client}>
        <DesignProvider locale="en" link={Link as LinkComponent}>
          <SidebarHarness />
        </DesignProvider>
      </QueryClientProvider>,
    );
    const head = (name: string) =>
      screen.getByRole("button", { name }).closest('[data-part="group-label"]');
    expect(initialIn(head("echo agent"))).toBe("E");
    expect(
      head("echo agent")?.querySelector('[data-part="avatar"]')?.getAttribute("data-size"),
    ).toBe("16");
    expect(head("Beta")?.querySelector('[data-part="avatar"]')?.getAttribute("data-preset")).toBe(
      "owl",
    );
    expect(initialIn(head("gone agent"))).toBe("G");
    // nothing read the agents for the sidebar
    expect(client.getQueryState(agentsQuery("o1").queryKey)?.fetchStatus).toBe("idle");
  });
});

describe("the environment picker (environments design §4.1)", () => {
  const picker = () =>
    screen.queryByRole("button", { name: new RegExp(`^${en.chat.pickEnvironment}: `) });
  const withEnvironments = (environments: unknown) => ({
    ...routes(),
    [`GET ${ORG}/environments`]: () => json(200, environments),
  });
  const send = async (text: string) => {
    const user = userEvent.setup();
    await user.type(input(), `${text}{Enter}`);
    return user;
  };
  const createdAt = () => json(201, { ...CONV("c9", { agentId: "ag2" }), event: userMsg(1, "go") });

  it("new conversation sends the chosen environment", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations`]: createdAt });
    await renderRouteWithCache("/", withEnvironments(ENVIRONMENTS));
    const user = userEvent.setup();
    expect(picker()?.textContent).toContain(en.environments.personal);
    await user.click(picker() as HTMLElement);
    // the one whose provider is gone is listed but cannot be chosen
    const gone = await screen.findByRole("menuitemradio", { name: /Old box/ });
    expect(gone.hasAttribute("data-disabled")).toBe(true);
    expect(gone.textContent).toContain(en.environments.state.unavailable);
    await user.click(screen.getByRole("menuitemradio", { name: /Build box/ }));
    expect(picker()?.textContent).toContain("Build box");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      message: { text: "go" },
      environmentId: "e2",
    });
  });

  it("picker defaults to the last used environment", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations`]: createdAt });
    await renderRouteWithCache("/", withEnvironments({ ...ENVIRONMENTS, lastUsedId: "e2" }));
    expect(picker()?.textContent).toContain("Build box");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ environmentId: "e2" });
  });

  it("falls back to the default when the last used one is unavailable", async () => {
    resetNavigation("/");
    await renderRouteWithCache("/", withEnvironments({ ...ENVIRONMENTS, lastUsedId: "e3" }));
    expect(picker()?.textContent).toContain(en.environments.personal);
  });

  it("an environment whose files are lost is tagged and not preselected", async () => {
    resetNavigation("/");
    const lost = {
      ...ENVIRONMENTS,
      items: ENVIRONMENTS.items.map((e) => (e.id === "e2" ? { ...e, filesLost: true } : e)),
      lastUsedId: "e2",
    };
    await renderRouteWithCache("/", withEnvironments(lost));
    expect(picker()?.textContent).toContain(en.environments.personal);
    const user = userEvent.setup();
    await user.click(picker() as HTMLElement);
    const item = await screen.findByRole("menuitemradio", { name: /Build box/ });
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(en.environments.state.filesLost);
  });

  it("picker disables an offline device environment", async () => {
    resetNavigation("/");
    const devices = {
      ...ENVIRONMENTS,
      items: [
        ...ENVIRONMENTS.items,
        envView("d1", "Laptop", { source: "device", provider: "@device", online: true }),
        envView("d2", "Server", { source: "device", provider: "@device", online: false }),
      ],
      lastUsedId: "d2",
    };
    await renderRouteWithCache("/", withEnvironments(devices));
    // the last used one is offline: it is not preselected
    expect(picker()?.textContent).toContain(en.environments.personal);
    const user = userEvent.setup();
    await user.click(picker() as HTMLElement);
    const offline = await screen.findByRole("menuitemradio", { name: /Server/ });
    expect(offline.hasAttribute("data-disabled")).toBe(true);
    expect(offline.textContent).toContain(en.environments.state.offline);
    const online = screen.getByRole("menuitemradio", { name: /Laptop/ });
    expect(online.hasAttribute("data-disabled")).toBe(false);
    expect(online.textContent).toContain(en.environments.state.online);
  });

  it("without a cloud sandbox the picker still lists the connected environments", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations`]: createdAt });
    await renderRouteWithCache(
      "/",
      withEnvironments({
        items: [envView("d1", "Laptop", { source: "device", provider: "@device", online: true })],
        defaultId: null,
        lastUsedId: null,
        cloudAvailable: false,
      }),
    );
    expect(picker()?.textContent).toContain("Laptop");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ environmentId: "d1" });
  });

  it("without a cloud sandbox and only offline devices, send waits and says why", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations`]: createdAt });
    await renderRouteWithCache(
      "/",
      withEnvironments({
        items: [envView("d1", "Laptop", { source: "device", provider: "@device", online: false })],
        defaultId: null,
        lastUsedId: null,
        cloudAvailable: false,
      }),
    );
    expect(picker()?.textContent).toContain("—");
    expect(screen.getByText(en.chat.environmentOffline)).toBeTruthy();
    await send("go");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("without a sandbox provider there is no picker and the send carries no environment", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations`]: createdAt });
    await renderRouteWithCache(
      "/",
      withEnvironments({ items: [], defaultId: null, lastUsedId: null, cloudAvailable: false }),
    );
    expect(picker()).toBeNull();
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).not.toHaveProperty("environmentId");
  });
});

const sidebarBase: Omit<SidebarProps, "conversations"> = {
  context: { kind: "work", org: null, primary: [], more: [] },
  newConversation: { href: "/agents" },
  activeNav: "",
  account: { name: "Grant", menu: [] },
  onOpenCommands: () => {},
};

function SidebarHarness() {
  const conversations = useConversationGroups("o1", "/");
  return <Sidebar {...sidebarBase} conversations={conversations} mode="full" />;
}

describe("the new conversation on a touch device (phones, maintainer decision 2026-11-09)", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  /** A coarse primary pointer, no fine one (a phone). */
  const touch = () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  };

  it("lists the agent's quick actions on the page; a tap fills the composer without focusing it", async () => {
    expectNoFirstPaintFetch();
    touch();
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    const list = document.querySelector('[data-part="quick-action-list"]') as HTMLElement;
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Plan", "Review", "Draft", "Polish", "Ship"]);
    await user.click(within(list).getByRole("button", { name: "Review" }));
    expect(input()).toHaveProperty("value", "Review body");
    // no keyboard popping up for a tap that only placed the text
    expect(document.activeElement).not.toBe(input());
  });

  it("choosing an agent does not focus the composer", async () => {
    touch();
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.click(within(row() as HTMLElement).getByRole("button", { name: "Alpha" }));
    expect(input().getAttribute("placeholder")).toBe("What should Alpha do?");
    expect(document.activeElement).not.toBe(input());
    // the list follows the agent
    const list = document.querySelector('[data-part="quick-action-list"]') as HTMLElement;
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Summarize", "Translate"]);
  });
});
