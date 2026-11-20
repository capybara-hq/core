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
import { keys } from "../src/lib/query/keys";
import { conversationGroupsQuery } from "../src/lib/query/shell";
import { bodyOf, json, stubApi } from "./support/api";
import {
  CONV,
  DEVICES,
  ENV_SANDBOX,
  envView,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  noProjects,
  permissionPreview,
  permissionsView,
  renderChatRoute,
  snapshotDefaults,
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

const group = (
  id: string,
  name: string,
  latestAt: string,
  avatar: AgentProfile["avatar"] = null,
) => ({
  agent: { id, name, profile: { avatar, updatedAt: "2026-10-20T06:32:00.000Z" } },
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
  [`GET ${ORG}/devices`]: () => json(200, DEVICES),
  ...noProjects(),
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
      [`POST ${ORG}/conversations/first-message`]: () =>
        json(201, {
          ...CONV("c9", { agentId: "ag1" }),
          event: userMsg(1, "go"),
          events: [userMsg(1, "go")],
        }),
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

    // the sidebar group titles (16), from the avatars the groups carry (no agents list cached)
    const client = testQueryClient();
    client.setQueryData(conversationGroupsQuery("o1").queryKey, {
      groups: [
        { ...group("ag1", "echo agent", "2026-11-03T08:00:00.000Z") },
        { ...group("ag2", "Beta", "2026-11-02T08:00:00.000Z", { kind: "preset", id: "owl" }) },
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
    expect(client.getQueryState(agentsQuery("o1").queryKey)).toBeUndefined();
  });
});

describe("?draft= (a setup guide's 让智能体协助)", () => {
  it("prefills the composer once and sends nothing until the person sends", async () => {
    const calls = stubApi(routes());
    const draft = "Help me finish setting up “Create the Slack app” for Acme Bot.\n\nSetup guide";
    await renderRouteWithCache(`/?draft=${encodeURIComponent(draft)}`, routes());
    await vi.waitFor(() => expect(input()).toHaveProperty("value", draft));
    // the page settled (its greeting is picked after mount); nothing but the person sends
    await screen.findByRole("heading", { name: /Grant/ });
    await act(async () => {});
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    // the agent the home picks (the most recent one)
    expect(input().getAttribute("placeholder")).toBe("What should Beta do?");
  });

  it("a blank draft leaves the composer empty", async () => {
    await renderRouteWithCache("/?draft=%20%20", routes());
    await vi.waitFor(() => expect(input()).toHaveProperty("value", ""));
  });
});

describe("the device picker (environments design §4.1)", () => {
  const picker = () =>
    screen.queryByRole("button", { name: new RegExp(`^${en.chat.pickDevice}: `) });
  const withDevices = (devices: unknown) => ({
    ...routes(),
    [`GET ${ORG}/devices`]: () => json(200, devices),
  });
  const send = async (text: string) => {
    const user = userEvent.setup();
    await user.type(input(), `${text}{Enter}`);
    return user;
  };
  const createdAt = () =>
    json(201, {
      ...CONV("c9", { agentId: "ag2" }),
      event: userMsg(1, "go"),
      events: [userMsg(1, "go")],
    });

  it("new conversation sends the chosen device", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache("/", withDevices(DEVICES));
    const user = userEvent.setup();
    expect(picker()?.textContent).toContain(en.devices.personal);
    await user.click(picker() as HTMLElement);
    // the one whose provider is gone is listed but cannot be chosen
    const gone = await screen.findByRole("menuitemradio", { name: /Old box/ });
    expect(gone.hasAttribute("data-disabled")).toBe(true);
    expect(gone.textContent).toContain(en.devices.state.unavailable);
    await user.click(screen.getByRole("menuitemradio", { name: /Build box/ }));
    expect(picker()?.textContent).toContain("Build box");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      message: { text: "go" },
      deviceId: "e2",
    });
  });

  it("picker defaults to the last used device", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache("/", withDevices({ ...DEVICES, lastUsedId: "e2" }));
    expect(picker()?.textContent).toContain("Build box");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ deviceId: "e2" });
  });

  it("falls back to the default when the last used one is unavailable", async () => {
    resetNavigation("/");
    await renderRouteWithCache("/", withDevices({ ...DEVICES, lastUsedId: "e3" }));
    expect(picker()?.textContent).toContain(en.devices.personal);
  });

  it("a device whose files are lost is tagged and not preselected", async () => {
    resetNavigation("/");
    const lost = {
      ...DEVICES,
      items: DEVICES.items.map((e) => (e.id === "e2" ? { ...e, filesLost: true } : e)),
      lastUsedId: "e2",
    };
    await renderRouteWithCache("/", withDevices(lost));
    expect(picker()?.textContent).toContain(en.devices.personal);
    const user = userEvent.setup();
    await user.click(picker() as HTMLElement);
    const item = await screen.findByRole("menuitemradio", { name: /Build box/ });
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(en.devices.state.filesLost);
  });

  it("picker disables an offline local device", async () => {
    resetNavigation("/");
    const devices = {
      ...DEVICES,
      items: [
        ...DEVICES.items,
        envView("d1", "Laptop", { source: "local", provider: "@local", online: true }),
        envView("d2", "Server", { source: "local", provider: "@local", online: false }),
      ],
      lastUsedId: "d2",
    };
    await renderRouteWithCache("/", withDevices(devices));
    // the last used one is offline: it is not preselected
    expect(picker()?.textContent).toContain(en.devices.personal);
    const user = userEvent.setup();
    await user.click(picker() as HTMLElement);
    const offline = await screen.findByRole("menuitemradio", { name: /Server/ });
    expect(offline.hasAttribute("data-disabled")).toBe(true);
    expect(offline.textContent).toContain(en.devices.state.offline);
    const online = screen.getByRole("menuitemradio", { name: /Laptop/ });
    expect(online.hasAttribute("data-disabled")).toBe(false);
    expect(online.textContent).toContain(en.devices.state.online);
  });

  it("the picker draws no daily auto / sandbox mark on local devices", async () => {
    resetNavigation("/");
    const sandbox = (outsideSandbox: boolean) => ({
      ...ENV_SANDBOX,
      network: "allowlist",
      outsideSandbox,
      layer: { network: "device", outsideSandbox: outsideSandbox ? null : "device" },
    });
    const local = { source: "local", provider: "@local", online: true };
    const devices = {
      ...DEVICES,
      items: [
        ...DEVICES.items,
        envView("d1", "Laptop", { ...local, sandbox: sandbox(true) }),
        envView("d2", "Server", { ...local, sandbox: sandbox(false) }),
      ],
    };
    await renderRouteWithCache("/", withDevices(devices));
    const user = userEvent.setup();
    await user.click(picker() as HTMLElement);
    const open = await screen.findByRole("menuitemradio", { name: /Laptop/ });
    const mark = (item: HTMLElement) => item.querySelector(".cb-badge");
    // the conversation's permission picker says what may run; the location picker names places
    expect(mark(open)).toBeNull();
    expect(mark(screen.getByRole("menuitemradio", { name: /Server/ }))).toBeNull();
    for (const item of screen.getAllByRole("menuitemradio")) {
      expect(item.textContent).not.toMatch(/\b(Auto|Sandbox)\b/);
    }
  });

  it("without a cloud sandbox the picker still lists the local devices", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache(
      "/",
      withDevices({
        items: [envView("d1", "Laptop", { source: "local", provider: "@local", online: true })],
        defaultId: null,
        lastUsedId: null,
        cloudAvailable: false,
      }),
    );
    expect(picker()?.textContent).toContain("Laptop");
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ deviceId: "d1" });
  });

  it("without a cloud sandbox and only offline devices, a restricted first send goes without a device", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache(
      "/",
      withDevices({
        items: [envView("d1", "Laptop", { source: "local", provider: "@local", online: false })],
        defaultId: null,
        lastUsedId: null,
        cloudAvailable: false,
      }),
    );
    expect(picker()?.textContent).toContain("—");
    // the reason is said, without blocking a device-less conversation
    expect(screen.getByText(en.chat.deviceOffline)).toBeTruthy();
    const user = userEvent.setup();
    // Full access needs a device; the restricted choices stay
    await user.click(screen.getByRole("button", { name: /^Permissions: / }));
    const full = await screen.findByRole("menuitemradio", { name: /^Full access/ });
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(full.textContent).toContain(en.chat.permission.reason.noDevice);
    await user.click(screen.getByRole("menuitemradio", { name: /^Request approval/ }));
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const body = bodyOf(calls.find((c) => c.method === "POST")) as Record<string, unknown>;
    expect(body).not.toHaveProperty("deviceId");
    expect(body).not.toHaveProperty("project");
    expect(body.permission).toEqual({ profile: "request-approval" });
    // no device: no preview read, nothing provisioned
    expect(calls.filter((c) => c.url.includes("permission-preview"))).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([
      `${ORG}/conversations/first-message`,
    ]);
  });

  it("without a sandbox provider there is no picker and the send carries no device", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache(
      "/",
      withDevices({ items: [], defaultId: null, lastUsedId: null, cloudAvailable: false }),
    );
    expect(picker()).toBeNull();
    await send("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const body = bodyOf(calls.find((c) => c.method === "POST")) as Record<string, unknown>;
    expect(body).not.toHaveProperty("deviceId");
    expect(body.permission).toEqual({ profile: "approve-for-me" });
    expect(calls.filter((c) => c.url.includes("permission-preview"))).toEqual([]);
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

  it("a ?draft= prefills the phone composer without focusing it", async () => {
    touch();
    await renderRouteWithCache("/?draft=Help%20me", routes());
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "Help me"));
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

describe("the first send carries the permission choice (atomic first message, Task 10 slice C)", () => {
  const FIRST = `POST ${ORG}/conversations/first-message`;
  const PREVIEW_E1 = `GET ${ORG}/conversation-permission-preview?deviceId=e1`;
  const created =
    (id = "c9", events?: unknown[]) =>
    () =>
      json(201, {
        ...CONV(id, { agentId: "ag2" }),
        event: userMsg(1, "go"),
        events: events ?? [userMsg(1, "go")],
      });
  const conflict = () =>
    json(409, { error: { code: "conflict", message: "The displayed permission scope changed" } });
  const permissionButton = () => screen.getByRole("button", { name: /^Permissions: / });
  const writes = (calls: { method: string; url: string }[]) =>
    calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
  const firstBodies = (calls: { method: string; url: string; body: unknown }[]) =>
    calls.filter((c) => c.method === "POST").map((c) => String(c.body));
  const idOf = (body: string | undefined) =>
    (JSON.parse(body ?? "{}") as { message: { clientMessageId: string } }).message.clientMessageId;
  async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(permissionButton());
    await user.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }));
  }
  async function chooseFull(user: ReturnType<typeof userEvent.setup>) {
    await vi.waitFor(async () => {
      await user.click(permissionButton());
      const full = await screen.findByRole("menuitemradio", { name: /^Full access/ });
      expect(full.getAttribute("aria-disabled")).toBeNull();
      await user.click(full);
    });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use Full access" }));
    await vi.waitFor(() =>
      expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Full access/),
    );
  }
  const retryOriginal = () =>
    screen.getAllByRole("button", { name: en.chat.firstSend.retryOriginal });

  it("Approve for me is the default and the only write is one first-message request", async () => {
    const browser = expectNoFirstPaintFetch();
    const calls = stubApi({ [FIRST]: created() });
    await renderRouteWithCache("/", routes());
    expect(browser).toEqual([]);
    expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Approve for me/);
    await userEvent.setup().type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    // never the legacy create, never a create-then-PATCH
    expect(writes(calls)).toEqual([FIRST]);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      agentId: "ag2",
      deviceId: "e1",
      message: { text: "go" },
      permission: { profile: "approve-for-me" },
    });
  });

  it("Request approval reaches the first message with the model choice", async () => {
    const calls = stubApi({ [FIRST]: created() });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await choose(user, "Request approval");
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(writes(calls)).toEqual([FIRST]);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      permission: { profile: "request-approval" },
      deviceId: "e1",
    });
  });

  it("Full access asks first and sends the consented scope revision of the displayed device", async () => {
    const calls = stubApi({ [FIRST]: created() });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.click(permissionButton());
    await user.click(await screen.findByRole("menuitemradio", { name: /^Full access/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Commands still run in the sandbox");
    // cancel changes nothing
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Approve for me/);
    await chooseFull(user);
    // unprobed: Full stays choosable with no note in the menu, nothing provisioned
    await user.click(permissionButton());
    expect(screen.getByRole("menu").textContent).not.toContain("Checked when this device starts");
    await user.keyboard("{Escape}");
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(writes(calls)).toEqual([FIRST]);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      deviceId: "e1",
      permission: { profile: "full-access", consentScopeRevision: "scope-1" },
    });
  });

  it("another device clears Full back to Approve for me before the send", async () => {
    const calls = stubApi({
      [FIRST]: created(),
      [`GET ${ORG}/conversation-permission-preview?deviceId=e2`]: () =>
        json(200, permissionPreview({ deviceId: "e2", scopeRevision: "scope-9" })),
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await chooseFull(user);
    await user.click(screen.getByRole("button", { name: new RegExp(`^${en.chat.pickDevice}: `) }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Build box/ }));
    await vi.waitFor(() =>
      expect(permissionButton().getAttribute("aria-label")).toBe("Permissions: Approve for me"),
    );
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      deviceId: "e2",
      permission: { profile: "approve-for-me" },
    });
  });

  it("on a phone the options sheet chooses the profile the first message carries", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const calls = stubApi({ [FIRST]: created() });
      await renderRouteWithCache("/", routes());
      const user = userEvent.setup();
      await user.click(document.querySelector('[data-part="composer-options"]') as HTMLElement);
      const sheet = screen.getByRole("dialog");
      const group = within(sheet).getByRole("radiogroup", { name: "Permissions" });
      await user.click(within(group).getByRole("radio", { name: /^Request approval/ }));
      await user.keyboard("{Escape}");
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await user.type(input(), "go{Enter}");
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
        permission: { profile: "request-approval" },
      });
    } finally {
      window.matchMedia = original;
    }
  });

  it("a lost reply is retried with the same bytes and id: one conversation, one navigation", async () => {
    let n = 0;
    const calls = stubApi({
      [FIRST]: () => {
        n += 1;
        if (n === 1) throw new TypeError("Failed to fetch");
        return created()();
      },
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.type(input(), "go{Enter}");
    // the outcome is unknown: the draft comes back, nothing claims the create failed
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "go"));
    expect(document.body.textContent).toContain(en.chat.firstSend.unconfirmed);
    expect(router.replace).not.toHaveBeenCalled();
    // an unchanged send is the original's retry
    await user.click(input());
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const bodies = firstBodies(calls);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("stale Full consent (409): the original stays recoverable, consent is asked again, the updated send is a new request", async () => {
    let n = 0;
    const calls = stubApi({
      [FIRST]: () => {
        n += 1;
        return n <= 2 ? conflict() : created()();
      },
      [PREVIEW_E1]: () =>
        json(200, permissionPreview({ deviceId: "e1", scopeRevision: "scope-2" })),
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await chooseFull(user);
    await user.type(input(), "go{Enter}");
    // the draft comes back, Full consent is dropped, the device's preview is read again
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "go"));
    expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Approve for me/);
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url.endsWith("preview?deviceId=e1"))).toBe(
        true,
      ),
    );
    expect(document.body.textContent).toContain(en.chat.firstSend.conflict);
    expect(router.replace).not.toHaveBeenCalled();
    // Retry original sends the original bytes and id again; another conflict sends nothing more
    await user.click(retryOriginal()[0] as HTMLElement);
    await vi.waitFor(() => expect(n).toBe(2));
    // settled: its recovery line is back (hidden while it is on its way), and nothing more went
    await vi.waitFor(() => expect(retryOriginal()).toHaveLength(1));
    expect(n).toBe(2);
    const [first, retried] = firstBodies(calls);
    expect(retried).toBe(first);
    // the composer kept the person's draft through the retry
    expect(input()).toHaveProperty("value", "go");
    // fresh consent to the new scope, then the updated send: a new id, the new revision
    await chooseFull(user);
    await user.click(input());
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const bodies = firstBodies(calls);
    expect(bodies).toHaveLength(3);
    expect(JSON.parse(bodies[0] as string).permission).toEqual({
      profile: "full-access",
      consentScopeRevision: "scope-1",
    });
    expect(JSON.parse(bodies[2] as string).permission).toEqual({
      profile: "full-access",
      consentScopeRevision: "scope-2",
    });
    expect(idOf(bodies[2])).not.toBe(idOf(bodies[0]));
    expect(writes(calls).every((w) => w === FIRST)).toBe(true);
  });

  it("a 409 drops Full consent even when the scope read again looks unchanged", async () => {
    const calls = stubApi({
      [FIRST]: conflict,
      [PREVIEW_E1]: () => json(200, permissionPreview({ deviceId: "e1" })),
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await chooseFull(user);
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "go"));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url.endsWith("preview?deviceId=e1"))).toBe(
        true,
      ),
    );
    expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Approve for me/);
    // settled into its recovery line; nothing resent on its own
    await vi.waitFor(() => expect(retryOriginal()).toHaveLength(1));
    expect(writes(calls)).toEqual([FIRST]);
  });

  it("lost reply, then a changed profile and a generic conflict: the original is still recovered with its own bytes", async () => {
    let n = 0;
    const calls = stubApi({
      [FIRST]: () => {
        n += 1;
        if (n === 1) throw new TypeError("Failed to fetch");
        if (n === 2) return conflict();
        return created()();
      },
    });
    await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "go"));
    // a changed choice makes it a new logical request with a new id
    await choose(user, "Request approval");
    await user.click(input());
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(n).toBe(2));
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "go"));
    const [original, updated] = firstBodies(calls);
    expect(idOf(updated)).not.toBe(idOf(original));
    expect(JSON.parse(updated as string).permission).toEqual({ profile: "request-approval" });
    // both stay recoverable, each line naming its text, profile and device; only the original's
    // choices differ from the composer's now
    expect(retryOriginal()).toHaveLength(2);
    const lines = retryOriginal().map((b) => b.parentElement?.textContent ?? "");
    expect(lines[0]).toContain("“go” with Approve for me on Personal.");
    expect(lines[0]).toContain(en.chat.firstSend.changed);
    expect(lines[1]).toContain("“go” with Request approval on Personal.");
    expect(lines[1]).toContain(en.chat.firstSend.newRequest);
    await user.click(retryOriginal()[0] as HTMLElement);
    await vi.waitFor(() => expect(n).toBe(3));
    expect(firstBodies(calls)[2]).toBe(original);
    // the original's own conversation is offered; the newer draft and view stay
    const open = await screen.findByRole("link", { name: en.chat.firstSend.open });
    expect(open.getAttribute("href")).toBe("/chat/c9");
    expect(router.replace).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "go");
    expect(permissionButton().getAttribute("aria-label")).toMatch(/^Permissions: Request approval/);
  });

  it("a 409 on the original for another device refreshes that device's preview too", async () => {
    let n = 0;
    stubApi({
      [FIRST]: () => {
        n += 1;
        if (n === 1) throw new TypeError("Failed to fetch");
        return conflict();
      },
      [`GET ${ORG}/conversation-permission-preview?deviceId=e2`]: () =>
        json(200, permissionPreview({ deviceId: "e2" })),
      [PREVIEW_E1]: () => json(200, permissionPreview({ deviceId: "e1" })),
    });
    const { client } = await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await chooseFull(user);
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(retryOriginal()).toHaveLength(1));
    // another device on display, then the original (Full on e1) is retried and refused
    await user.click(screen.getByRole("button", { name: new RegExp(`^${en.chat.pickDevice}: `) }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Build box/ }));
    await user.click(retryOriginal()[0] as HTMLElement);
    await vi.waitFor(() => expect(n).toBe(2));
    await vi.waitFor(() => expect(retryOriginal()).toHaveLength(1));
    expect(retryOriginal()[0]?.parentElement?.textContent).toContain(
      "“go” with Full access on Personal.",
    );
    expect(client.getQueryState(keys.org("o1").permissionPreview("e1"))?.isInvalidated).toBe(true);
  });

  it("a late answer after the page is gone neither navigates nor resends", async () => {
    let answer: (r: Response) => void = () => {};
    const calls = stubApi({
      [FIRST]: () =>
        new Promise<Response>((r) => {
          answer = r;
        }),
    });
    const { client } = await renderRouteWithCache("/", routes());
    await userEvent.setup().type(input(), "go{Enter}");
    await vi.waitFor(() => expect(document.querySelector("[data-pending]")).not.toBeNull());
    cleanup();
    await act(async () => answer(created()()));
    // the answer was handled: the cache is seeded and the sidebar's groups marked stale, which
    // happens right before the page's own (skipped) navigation
    await vi.waitFor(() =>
      expect(client.getQueryState(conversationGroupsQuery("o1").queryKey)?.isInvalidated).toBe(
        true,
      ),
    );
    expect(client.getQueryData(keys.org("o1").conversation("c9").row())).toBeDefined();
    expect(router.replace).not.toHaveBeenCalled();
    expect(writes(calls)).toEqual([FIRST]);
  });

  it("the chosen profile survives the handoff: the recorded label shows while the owner read loads, never Approve", async () => {
    const calls = stubApi({
      [FIRST]: created("c1", [
        ev(
          1,
          "permission_profile_changed",
          {
            oldProfile: "approve-for-me",
            newProfile: "request-approval",
            actorAccountId: "a1",
            deviceId: "e1",
            scopeRevision: null,
            revision: 0,
          },
          null,
        ),
        { ...userMsg(2, "go"), runId: null },
      ]),
    });
    const view = await renderRouteWithCache("/", routes());
    const user = userEvent.setup();
    await choose(user, "Request approval");
    await user.type(input(), "go{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c1"));
    // the pending bubble showed once and the composer never said Approve for me
    stubApi({
      ...snapshotDefaults("c1"),
      [`GET ${ORG}/conversations/c1/permissions`]: () => new Promise<Response>(() => {}),
    });
    await act(() => view.navigate("/chat/c1"));
    const mode = await vi.waitFor(() => {
      const p = document.querySelector('[data-part="composer-mode"]') as HTMLElement;
      expect(within(p).getByText("Request approval")).toBeTruthy();
      return p;
    });
    expect(within(mode).queryByText("Approve for me")).toBeNull();
    expect(screen.getAllByText("go")).toHaveLength(1);
    expect(writes(calls)).toEqual([FIRST]);
  });

  it("a shared viewer of a conversation never sees the recorded profile as a live choice", async () => {
    stubApi({
      ...snapshotDefaults("c1"),
      [`GET ${ORG}/conversations/c1`]: () => json(200, CONV("c1", { accountId: "someone-else" })),
      [`GET ${ORG}/conversations/c1/events`]: () =>
        json(200, {
          events: [
            ev(
              1,
              "permission_profile_changed",
              {
                oldProfile: "approve-for-me",
                newProfile: "full-access",
                actorAccountId: "someone-else",
                deviceId: "e1",
                scopeRevision: "scope-1",
                revision: 0,
              },
              null,
            ),
            userMsg(2, "hi"),
          ],
        }),
      [`GET ${ORG}/conversations/c1/permissions`]: () => json(200, permissionsView()),
    });
    const { calls } = await renderChatRoute({ locale: "en" });
    await screen.findByText("hi");
    expect(screen.queryByText("Full access")).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/permissions"))).toEqual([]);
  });
});
