import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { draftText, sendComposer, typeComposer } from "./support/composer";
import {
  AGENTS,
  CONV,
  DEVICES,
  envView,
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
import { expectNoFirstPaintFetch } from "./support/server";

/**
 * Project root spec §4.3, §4.6 (plan Task 12), composer menus spec §6: a new conversation is bound
 * to one of its device's projects from the project picker after the device picker in the composer's
 * top strip (free mode by default); an existing conversation shows its device and project read
 * only; the conversation names its project and whether it loaded (or why it is unavailable) from
 * the view's `projectState` (the latest `project_root` event, wherever it lies in the log); the `/`
 * menu groups its entries by source, the project's skills under their own heading.
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
const ROOT = "/Users/o/src/core";
const CORE = { name: "core", path: ROOT };

const projectsOf = (over: Record<string, unknown> = {}) => ({
  projects: [
    { ...CORE, createdAt: "2026-11-15T00:00:00.000Z" },
    { name: "plugins", path: "/Users/o/src/plugins", createdAt: "2026-11-15T00:00:00.000Z" },
  ],
  hidden: 0,
  mode: "auto",
  base: "/Users/o",
  supported: true,
  ...over,
});

const GROUPS = { groups: [], next: null };

/** The new conversation's reads; `projects` answers the default device's projects. */
const newRoutes = (projects: unknown = projectsOf()) => ({
  [`GET ${ORG}/files/limits`]: () => json(200, LIMITS),
  [`GET ${ORG}/agents`]: () => json(200, AGENTS),
  [`GET ${ORG}/models`]: () => json(200, MODELS),
  [`GET ${ORG}/devices`]: () => json(200, DEVICES),
  [`GET ${ORG}/devices/e1/projects`]: () => json(200, projects),
  [`GET ${ORG}/conversation-permission-preview?deviceId=e1`]: () =>
    json(200, permissionPreview({ deviceId: "e1" })),
  [`GET ${ORG}/conversations/groups`]: () => json(200, GROUPS),
});

const input = (m = en) => screen.getByRole("combobox", { name: m.chat.inputLabel, hidden: true });
const devicePicker = (m = en) =>
  screen.getByRole("button", { name: new RegExp(`^${m.chat.pickDevice}: `) });
const projectPicker = (m = en) =>
  screen.queryByRole("button", { name: new RegExp(`^${m.chat.projectGroup}: `) });
const strip = (container: HTMLElement) =>
  container.querySelector('[data-part="composer-place-full"]') as HTMLElement;
const createdAt = () =>
  json(201, { ...CONV("c9"), event: userMsg(1, "go"), events: [userMsg(1, "go")] });

beforeEach(() => {
  params.conversationId = "c1";
  for (const k of [...search.keys()]) search.delete(k);
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("binding a new conversation to a project (the top strip)", () => {
  it("offers 自由模式 and the chosen device's projects; the first paint reads nothing", async () => {
    resetNavigation("/");
    expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/", newRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    // the strip reads device / project above the text; the control row has no device picker
    const project = await vi.waitFor(() => projectPicker(zh) as HTMLElement);
    expect(project.getAttribute("aria-label")).toBe(`${zh.chat.projectGroup}: ${zh.chat.freeMode}`);
    const place = strip(container);
    expect(place.contains(devicePicker(zh))).toBe(true);
    expect(
      devicePicker(zh).compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const bar = container.querySelector('[data-part="composer-bar"]') as HTMLElement;
    expect(
      within(bar).queryByRole("button", { name: new RegExp(`^${zh.chat.pickDevice}: `) }),
    ).toBeNull();
    // the device's menu lists devices only
    await user.click(devicePicker(zh));
    const devices = await screen.findByRole("menu");
    expect(within(devices).queryByRole("menuitemradio", { name: zh.chat.freeMode })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(project);
    const menu = await screen.findByRole("menu");
    const free = within(menu).getByRole("menuitemradio", { name: zh.chat.freeMode });
    expect(free.getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemradio", { name: "core" })).toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "plugins" })).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a picked project is sent with the device and named on the picker", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache("/", newRoutes());
    const user = userEvent.setup();
    await user.click(await vi.waitFor(() => projectPicker() as HTMLElement));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    expect(projectPicker()?.textContent).toContain("core");
    expect(devicePicker().textContent).not.toContain("core");
    sendComposer("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      deviceId: "e1",
      project: "core",
    });
  });

  it("the / menu lists the picked project's skills (as last read) and sends one as project:<name>", async () => {
    resetNavigation("/");
    const INVOCABLE = `${ORG}/agents/ag1/invocable-skills`;
    const projectSkill = {
      id: "project:fix-issue",
      name: "project:fix-issue",
      source: "project",
      description: "Fix an issue",
      version: 0,
      manual: false,
      fork: false,
    };
    const routes = {
      ...newRoutes(),
      [`GET ${INVOCABLE}`]: () => json(200, { skills: [] }),
      [`GET ${INVOCABLE}?deviceId=e1&project=core`]: () => json(200, { skills: [projectSkill] }),
      [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
      [`POST ${ORG}/conversations/first-message`]: createdAt,
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/", routes);
    const user = userEvent.setup();
    await user.click(await vi.waitFor(() => projectPicker() as HTMLElement));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    typeComposer("/");
    await user.click(await screen.findByRole("option", { name: /^fix-issue/ }));
    // the picked skill is the draft's leading token
    expect(screen.getByRole("img", { name: "Skill: /fix-issue" })).toBeTruthy();
    expect(calls.some((c) => c.url === `${INVOCABLE}?deviceId=e1&project=core`)).toBe(true);
    sendComposer("1063");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      deviceId: "e1",
      project: "core",
      message: { skill: { name: "project:fix-issue" } },
    });
  });

  it("自由模式 (the default) sends no project", async () => {
    resetNavigation("/");
    const calls = stubApi({ [`POST ${ORG}/conversations/first-message`]: createdAt });
    await renderRouteWithCache("/", newRoutes());
    const _user = userEvent.setup();
    sendComposer("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).not.toHaveProperty("project");
  });

  it("another device has other projects: switching drops the pick", async () => {
    resetNavigation("/");
    const calls = stubApi({
      [`GET ${ORG}/devices/e2/projects`]: () =>
        json(200, projectsOf({ projects: [] as unknown[] })),
      [`POST ${ORG}/conversations/first-message`]: createdAt,
    });
    await renderRouteWithCache("/", newRoutes());
    const user = userEvent.setup();
    await user.click(await vi.waitFor(() => projectPicker() as HTMLElement));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    await user.click(devicePicker());
    await user.click(await screen.findByRole("menuitemradio", { name: /Build box/ }));
    // a device without projects offers no project choice
    await vi.waitFor(() => expect(projectPicker()).toBeNull());
    sendComposer("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const body = bodyOf(calls.find((c) => c.method === "POST"));
    expect(body).toMatchObject({ deviceId: "e2" });
    expect(body).not.toHaveProperty("project");
  });

  it("back to the first device: its project is not picked again (A → B → A)", async () => {
    resetNavigation("/");
    const calls = stubApi({
      [`GET ${ORG}/devices/e2/projects`]: () => json(200, projectsOf()),
      [`POST ${ORG}/conversations/first-message`]: createdAt,
    });
    await renderRouteWithCache("/", newRoutes());
    const user = userEvent.setup();
    await user.click(await vi.waitFor(() => projectPicker() as HTMLElement));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    await user.click(devicePicker());
    await user.click(await screen.findByRole("menuitemradio", { name: /Build box/ }));
    await vi.waitFor(() => expect(projectPicker()?.textContent).toBe(en.chat.freeMode));
    await user.click(devicePicker());
    await user.click(
      await screen.findByRole("menuitemradio", { name: new RegExp(en.devices.personal) }),
    );
    await vi.waitFor(() => expect(projectPicker()?.textContent).toBe(en.chat.freeMode));
    sendComposer("go");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const body = bodyOf(calls.find((c) => c.method === "POST"));
    expect(body).toMatchObject({ deviceId: "e1" });
    expect(body).not.toHaveProperty("project");
  });

  it("while another device's projects are read, the project picker stands disabled on 自由模式", async () => {
    resetNavigation("/");
    let answer: (r: Response) => void = () => {};
    const late = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    stubApi({ [`GET ${ORG}/devices/e2/projects`]: () => late });
    await renderRouteWithCache("/", newRoutes());
    const user = userEvent.setup();
    await user.click(await vi.waitFor(() => projectPicker() as HTMLElement));
    await user.click(await screen.findByRole("menuitemradio", { name: "core" }));
    await user.click(devicePicker());
    await user.click(await screen.findByRole("menuitemradio", { name: /Build box/ }));
    // it neither vanishes nor keeps the old device's pick while the read is on its way
    const waiting = await vi.waitFor(() => {
      const p = projectPicker() as HTMLElement;
      expect(p.textContent).toBe(en.chat.freeMode);
      return p;
    });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    // the compact sheet's project section says the read is on its way
    await user.click(document.querySelector('[data-part="composer-place-chip"]') as HTMLElement);
    const sheet = await screen.findByRole("dialog");
    const notice = sheet.querySelector('[data-part="place-notice"]') as HTMLElement;
    expect(notice.textContent).toBe(en.chat.projectsLoading);
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    answer(json(200, projectsOf({ projects: [{ name: "web", path: "/Users/o/src/web" }] })));
    await vi.waitFor(() => expect((projectPicker() as HTMLButtonElement).disabled).toBe(false));
    await user.click(projectPicker() as HTMLElement);
    expect(await screen.findByRole("menuitemradio", { name: "web" })).toBeTruthy();
  });

  it("a device that does not support projects offers no project choice", async () => {
    resetNavigation("/");
    await renderRouteWithCache(
      "/",
      newRoutes(projectsOf({ projects: [] as unknown[], supported: false })),
    );
    const user = userEvent.setup();
    await vi.waitFor(() => expect(devicePicker()).toBeTruthy());
    await vi.waitFor(() => expect(projectPicker()).toBeNull());
    await user.click(devicePicker());
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitemradio", { name: en.chat.freeMode })).toBeNull();
  });
});

/**
 * The conversation page's reads for a conversation bound to `core` (or `project`); its view
 * carries `projectState` (the state of its latest `project_root`).
 */
function chatApi(
  events: unknown[],
  extra: Record<string, (c: Call) => Response | Promise<Response>> = {},
  project: unknown = CORE,
  projectState: () => unknown = () => null,
) {
  return stubApi({
    [`GET ${BASE}`]: () =>
      json(200, CONV("c1", { deviceId: "e1", project, projectState: projectState() })),
    [`GET ${BASE}/device`]: () => json(200, { device: envView("e1", "Laptop") }),
    [`GET ${BASE}/events`]: () => json(200, { events }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    ...extra,
  });
}

const projectRoot = (seq: number, payload: Record<string, unknown>) =>
  ev(seq, "project_root", { project: "core", root: ROOT, skills: [], ...payload });

describe("an existing conversation's project", () => {
  it("the top strip shows the device and the project read only", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")]);
    const { container } = await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const locked = [...strip(container).querySelectorAll('[data-locked="true"]')];
    expect(locked.map((e) => e.textContent)).toEqual(["Laptop", "core"]);
    expect(locked.map((e) => e.getAttribute("title"))).toEqual([
      `Laptop: ${zh.chat.deviceLocked}`,
      `core: ${zh.chat.projectLocked}`,
    ]);
    // nothing in it can change: no buttons, and the compact chip is static text too
    expect(within(strip(container)).queryAllByRole("button")).toEqual([]);
    const chip = container.querySelector('[data-part="composer-place-chip"]') as HTMLElement;
    expect(chip.getAttribute("data-locked")).toBe("true");
  });

  it("a conversation in 自由模式 shows its device alone", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")], {}, null);
    const { container } = await renderChatRoute();
    await screen.findByText("hi");
    const locked = [...strip(container).querySelectorAll('[data-locked="true"]')];
    expect(locked.map((e) => e.textContent)).toEqual(["Laptop"]);
  });

  it.each(["zh", "en"] as const)(
    "names the project, its root and that AGENTS.md was loaded (%s)",
    async (locale) => {
      resetNavigation("/chat/c1");
      chatApi(
        [userMsg(1, "hi"), runStarted(2), projectRoot(3, { agentsMd: "Rules." })],
        {},
        CORE,
        () => ({ loaded: true, agentsMd: true }),
      );
      await renderChatRoute({ locale });
      await screen.findByText("hi");
      const m = locale === "zh" ? zh : en;
      const text = m.chat.project.loaded
        .replace("{name}", "core")
        .replace("{path}", ROOT)
        .replace("{file}", "AGENTS.md");
      expect(screen.getByText(text)).toBeTruthy();
    },
  );

  it("a project without AGENTS.md says so", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi"), runStarted(2), projectRoot(3, {})], {}, CORE, () => ({
      loaded: true,
      agentsMd: false,
    }));
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const text = zh.chat.project.noAgentsMd
      .replace("{name}", "core")
      .replace("{path}", ROOT)
      .replace("{file}", "AGENTS.md");
    expect(screen.getByText(text)).toBeTruthy();
  });

  it.each(["gone", "outside_mode", "unreadable", "unsupported", "removed"] as const)(
    "an unavailable project (%s) is a notice in both languages",
    async (reason) => {
      for (const locale of ["zh", "en"] as const) {
        resetNavigation("/chat/c1");
        chatApi(
          [
            userMsg(1, "hi"),
            runStarted(2),
            projectRoot(3, { agentsMd: "Rules." }),
            projectRoot(4, { unavailable: { reason, message: "Model text." } }),
          ],
          {},
          CORE,
          () => ({ unavailable: reason }),
        );
        await renderChatRoute({ locale });
        await screen.findByText("hi");
        const m = locale === "zh" ? zh : en;
        expect(
          screen.getByText(m.chat.project.unavailable[reason].replace("{name}", "core")),
        ).toBeTruthy();
        expect(screen.queryByText("Model text.")).toBeNull();
        expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
        cleanup();
      }
    },
  );

  it("marks an unavailable project in the composer and opens its details from that mark", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")], {}, CORE, () => ({ unavailable: "outside_mode" }));
    const { container } = await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const region = screen.getByRole("region", { name: "项目上下文" });
    expect(within(region).getByText(ROOT)).toBeTruthy();
    expect(within(region).getByRole("link", { name: "查看设备" }).getAttribute("href")).toBe(
      "/devices/e1",
    );
    expect(within(region).getByRole("link", { name: "新建自由对话" }).getAttribute("href")).toBe(
      "/?agent=ag1",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /项目 · core.*上下文未加载/ }));
    expect(screen.queryByRole("region", { name: "项目上下文" })).toBeNull();
    const composer = container.querySelector('[data-part="composer"]') as HTMLElement;
    await user.click(
      within(composer).getByRole("button", { name: new RegExp(`^${zh.chat.projectGroup}:`) }),
    );
    expect(screen.getByRole("region", { name: "项目上下文" })).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("opens project details before scrolling to them from the composer", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")], {}, CORE, () => ({ unavailable: "outside_mode" }));
    const { container } = await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /项目 · core.*上下文未加载/ }));
    const detailsAtScroll: boolean[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {
      detailsAtScroll.push(screen.queryByRole("region", { name: "项目上下文" }) !== null);
    });
    const composer = container.querySelector('[data-part="composer"]') as HTMLElement;
    await user.click(
      within(composer).getByRole("button", { name: new RegExp(`^${zh.chat.projectGroup}:`) }),
    );
    await vi.waitFor(() => expect(detailsAtScroll).toEqual([true]));
  });

  it("a snapshot outside the loaded window still shows its state", async () => {
    resetNavigation("/chat/c1");
    // the loaded window holds no project_root: only the view knows the latest one
    chatApi([userMsg(1, "hi"), runStarted(2)], {}, CORE, () => ({
      loaded: true,
      agentsMd: true,
    }));
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const text = zh.chat.project.loaded
      .replace("{name}", "core")
      .replace("{path}", ROOT)
      .replace("{file}", "AGENTS.md");
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("a new snapshot from the stream reads the view again", async () => {
    resetNavigation("/chat/c1");
    let state: unknown = { loaded: true, agentsMd: true };
    chatApi(
      [userMsg(1, "hi"), runStarted(2), projectRoot(3, { agentsMd: "Rules." })],
      {},
      CORE,
      () => state,
    );
    await renderChatRoute();
    await screen.findByText("hi");
    // the stream's first event ends its catch-up (which reads the side queries again)
    act(() => {
      FakeEventSource.instances[0]?.emit("event", userMsg(4, "more"));
    });
    await screen.findByText("more");
    state = { unavailable: "gone" };
    act(() => {
      FakeEventSource.instances[0]?.emit(
        "event",
        projectRoot(5, { unavailable: { reason: "gone", message: "Model text." } }),
      );
    });
    expect(
      await screen.findByText(en.chat.project.unavailable.gone.replace("{name}", "core")),
    ).toBeTruthy();
  });

  it("before its first run only the name shows", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")]);
    await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    const text = zh.chat.project.bound.replace("{name}", "core").replace("{path}", ROOT);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("a free conversation names no project", async () => {
    resetNavigation("/chat/c1");
    chatApi([userMsg(1, "hi")], {}, null);
    const { container } = await renderChatRoute({ locale: "zh" });
    await screen.findByText("hi");
    expect(container.textContent).not.toContain("core");
  });
});

describe("the / menu groups entries by source", () => {
  const INVOCABLE = `${ORG}/agents/ag1/invocable-skills`;
  const SKILLS = {
    skills: [
      {
        id: "s1",
        name: "brainstorming",
        source: "plugin",
        plugin: "superpowers",
        description: "Think first",
        version: 1,
        manual: false,
        fork: false,
      },
      {
        id: "s2",
        name: "notes",
        source: "agent",
        description: "Keep notes",
        version: 1,
        manual: false,
        fork: false,
      },
      {
        id: "s3",
        name: "review",
        source: "platform",
        description: "Review a change",
        version: 1,
        manual: false,
        fork: false,
      },
      {
        id: "project:fix-issue",
        name: "project:fix-issue",
        source: "project",
        description: "Fix an issue",
        version: 0,
        manual: false,
        fork: false,
      },
    ],
  };

  it("one menu, a heading per source, fix-issue tagged as the project's under its heading; it is sent as project:fix-issue", async () => {
    resetNavigation("/chat/c1");
    const calls = chatApi([userMsg(1, "hi"), runStarted(2), projectRoot(3, {})], {
      [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
      [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    typeComposer("/");
    await screen.findByRole("listbox");
    const dialog = document.querySelector('[data-part="composer-menu"]') as HTMLElement;
    await within(dialog).findByText("fix-issue");
    const headings = [...dialog.querySelectorAll('[data-part="composer-menu-label"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual([
      en.chat.skillSource.project,
      en.chat.skillSource.agent,
      en.chat.skillSource.platform,
      en.chat.skillSource.plugin,
      en.chat.commandsGroup,
    ]);
    const group = (label: string) =>
      within(dialog).getByRole("group", { name: label, hidden: true }) as HTMLElement;
    expect(
      within(group(en.chat.skillSource.project))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([`fix-issue${en.chat.skillSourceTag.project} · Fix an issue`]);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    await user.click(within(dialog).getByRole("option", { name: /^fix-issue/ }));
    sendComposer("42");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)).toHaveLength(
        1,
      ),
    );
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0] as Call)).toMatchObject({
      text: "42",
      skill: { name: "project:fix-issue" },
    });
  });

  it("a typed bare /fix-issue no other skill has is the project's: sent as project:fix-issue", async () => {
    resetNavigation("/chat/c1");
    const calls = chatApi([userMsg(1, "hi"), runStarted(2), projectRoot(3, {})], {
      [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
      [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "x") }),
    });
    await renderChatRoute();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(input());
    await user.paste("/fix-issue 42");
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)).toHaveLength(
        1,
      ),
    );
    const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(bodyOf(post[0] as Call)).toMatchObject({
      text: "42",
      skill: { name: "project:fix-issue" },
    });
  });

  it.each(["zh", "en"] as const)(
    "a typed project skill the project cannot serve is not resent as text; the draft stays and the reason shows (%s)",
    async (locale) => {
      resetNavigation("/chat/c1");
      const calls = chatApi([userMsg(1, "hi"), runStarted(2), projectRoot(3, {})], {
        [`GET ${INVOCABLE}`]: () => json(200, SKILLS),
        [`GET ${ORG}/connectors/prompts`]: () => json(200, { prompts: [], unavailable: [] }),
        [`POST ${BASE}/messages`]: () =>
          json(422, {
            error: {
              code: "skill.project_unavailable",
              message: "Skill cannot be invoked",
              details: [{ reason: "gone" }],
            },
          }),
      });
      await renderChatRoute({ locale });
      await screen.findByText("hi");
      const m = locale === "zh" ? zh : en;
      const user = userEvent.setup();
      await user.click(input(m));
      await user.paste("/project:fix-issue 42");
      await user.keyboard("{Enter}");
      expect(await screen.findByText(m.errors.skill.project_unavailable.gone)).toBeTruthy();
      const post = calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`);
      expect(post).toHaveLength(1);
      expect(bodyOf(post[0] as Call)).toMatchObject({ skill: { name: "project:fix-issue" } });
      expect(draftText()).toBe("/project:fix-issue 42");
    },
  );
});
