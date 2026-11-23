import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { WAIT_POLL_MS } from "../src/components/DeviceCreateDialog";
import { RESET_POLL_MS } from "../src/lib/devices";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { expectNoFirstPaintFetch } from "./support/server";
import { stubWindowWidth } from "./support/width";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

type RenderOpts = Parameters<typeof renderRouteWithCache>[2];
const BASE = "/api/v1/orgs/o1/devices";
/** The device page also reads the device's projects (project root §4.1): none here. */
const NO_PROJECTS = {
  [`GET ${BASE}/e1/projects`]: () =>
    json(200, { projects: [], base: "/workspace", supported: true }),
};
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;

const LIMITS = {
  cpu: 2,
  memoryMb: 2048,
  diskMb: 10240,
  network: { kind: "open-public", hosts: [] },
};
/** A device's sandbox (kernel `DeviceSandboxView`): a cloud device following its org's open network. */
const SANDBOX = {
  network: "open",
  networkCeiling: "open",
  hosts: [],
  ownNetwork: null,
  allowedDomains: [],
  outsideSandbox: false,
  layer: { network: null, outsideSandbox: "provider" },
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
};
/** What the provider last reported (kernel `DeviceReport`): it offers a file rebuild. */
const REPORT = {
  revision: "r1",
  description: { en: "A container on the platform" },
  home: null,
  limits: [],
  reset: true,
};
const env = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
  ownerKind: "personal",
  dialIn: false,
  provider: "sandbox-docker",
  providerDisplayName: null,
  available: true,
  online: null,
  machine: null,
  filesLost: false,
  instance: null,
  limits: LIMITS,
  report: REPORT,
  sandbox: SANDBOX,
  createdAt: T,
  ...over,
});
const DOCKER = {
  plugin: "sandbox-docker",
  displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
  description: { en: "Runs in a container", zh: "在容器里运行" },
  dialIn: false,
  guide: { itemId: "item-docker", guideId: "connect" },
};
const LOCAL = {
  plugin: "device-local",
  displayName: { zh: "本机", en: "Local machine" },
  description: { en: "Your own computer or server" },
  dialIn: true,
  guide: { itemId: "item-local", guideId: "connect" },
};
const DOCKER_GUIDE_TEXT = "Docker needs nothing installed";
const LOCAL_GUIDE_TEXT = "Run the connector on the machine";
/** The catalog guide route of a provider: a markdown block, and for a dial-in one the shell action. */
const guide = (p: { plugin: string; guide: { itemId: string; guideId: string } }) => ({
  [`GET /api/v1/orgs/o1/catalog/${p.guide.itemId}/guides/${p.guide.guideId}`]: () =>
    json(200, {
      guide: {
        itemId: p.guide.itemId,
        plugin: p.plugin,
        version: "0.1.0",
        id: p.guide.guideId,
        place: "device-connection",
        locale: "en",
        title: "Connect",
        modes: [],
        mode: null,
        audiences: ["member"],
        audience: "member",
        blocks:
          p.plugin === LOCAL.plugin
            ? [
                { kind: "markdown", text: LOCAL_GUIDE_TEXT },
                {
                  kind: "shell-action",
                  action: "connect-this-machine",
                  label: "Connect this machine",
                },
              ]
            : [{ kind: "markdown", text: DOCKER_GUIDE_TEXT }],
        checks: [],
        unresolved: [],
        hash: "a".repeat(64),
        target: null,
      },
    }),
});
const list = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  defaultId: "e1",
  lastUsedId: null,
  providers: [
    { plugin: "sandbox-docker", displayName: null, description: null, dialIn: false, guide: null },
  ],
  defaultProvider: "sandbox-docker",
  ...over,
});

const renderList = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices", lastStubRoutes(), opts);
const renderDetail = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices/e1", lastStubRoutes(), opts);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
/** The device page's Network tab. */
const openNetwork = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: E.detail.tabNetwork }));
  return user;
};
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
/**
 * Fakes the timers a poll runs on (TanStack's refetchInterval), still moving with real time so the
 * renders and the user events go on as usual; {@link nextPoll} then jumps to the next read.
 */
const fakePollTimers = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    shouldAdvanceTime: true,
  });
const nextPoll = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => resetNavigation("/devices"));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const routes = {
  [`GET ${BASE}`]: () =>
    json(
      200,
      list([
        env("e1", null, { instance: { status: "running", lastUsedAt: T } }),
        env("e2", "Build box", { filesLost: true }),
      ]),
    ),
  ...NO_PROJECTS,
  [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", "Build box") }),
};

describe("devices list", () => {
  it("lists cards: the default is 个人设备, with state and its ceiling mark", async () => {
    stubApi(routes);
    const { container } = await renderList();
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const cards = await screen.findAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText(E.personal)).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByText(E.state.running, { exact: false }),
    ).toBeTruthy();
    // the neutral sandbox mark, never a daily mode or network mark
    expect(
      within(cards[0] as HTMLElement).getByText(E.sandbox.mark.sandbox, { exact: false }),
    ).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Build box")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("sandbox-docker")).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText(E.state.filesLost, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Build box" }).getAttribute("href")).toBe(
      "/devices/e2",
    );
  });

  it("devices list first render from hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    stubApi(routes);
    await renderRouteWithCache("/devices", routes);
    expect(screen.getByText(E.personal)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("empty cache shows template loading, then cards", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/devices", {
      [`GET ${BASE}`]: async () => {
        await held;
        return routes[`GET ${BASE}`]();
      },
    });
    await vi.waitFor(() => expect(template("ListPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Build box")).toBeNull();
    // 新建设备 is not known yet: a placeholder holds its slot, so it does not pop in after load
    const slots = document.querySelector('[data-part="page-header-action-slots"]');
    expect(slots).not.toBeNull();
    expect(slots?.querySelectorAll('[data-part="skeleton-box"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: E.new })).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Build box")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    expect(screen.getByRole("button", { name: E.new })).toBeTruthy();
    expect(document.querySelector('[data-part="page-header-action-slots"]')).toBeNull();
  });

  it("no provider shows the empty state and offers no 新建设备", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, list([], { providers: [], defaultProvider: null, defaultId: null })),
    });
    await renderList();
    expect(await screen.findByText(E.noProviders.text)).toBeTruthy();
    expect(screen.getByText(E.noProviders.hint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.new })).toBeNull();
  });

  it("without a provider the existing devices are still listed as 不可用, with a notice", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([env("e1", "Old box", { available: false, provider: "sandbox-gone" })], {
            providers: [],
            defaultProvider: null,
            defaultId: null,
          }),
        ),
    });
    await renderList();
    const card = await screen.findByRole("listitem");
    expect(within(card).getByText("Old box")).toBeTruthy();
    expect(within(card).getByText(E.state.unavailable, { exact: false })).toBeTruthy();
    expect(screen.getByText(E.noProviders.notice)).toBeTruthy();
    expect(screen.queryByText(E.noProviders.text)).toBeNull();
  });

  it("a device whose instance never started is 未启动", async () => {
    stubApi({ [`GET ${BASE}`]: () => json(200, list([env("e1", "Fresh box")])) });
    await renderList();
    const card = await screen.findByRole("listitem");
    expect(within(card).getByText(E.state.notStarted, { exact: false })).toBeTruthy();
  });

  it("create invalidates devices and opens the new device", async () => {
    const calls = stubApi({
      ...routes,
      [`POST ${BASE}`]: () => json(201, { device: env("e3", "Scratch") }),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: E.create.submit });
    expect(submit).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "  Scratch ");
    expect(submit).toHaveProperty("disabled", false);
    await user.click(submit);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/e3"));
    const post = calls.find((c) => c.method === "POST");
    expect(bodyOf(post)).toEqual({ name: "Scratch", provider: "sandbox-docker" });
    // the list is read again after the POST (it was invalidated while on screen)
    await vi.waitFor(() => {
      const after = calls.slice(calls.indexOf(post as never)).map((c) => `${c.method} ${c.url}`);
      expect(after).toContain(`GET ${BASE}`);
    });
  });

  it("新建设备 with two providers: cards, the chosen guide, a name for a non-dial-in one", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([env("e1", null)], { providers: [DOCKER, LOCAL], defaultProvider: DOCKER.plugin }),
        ),
      [`POST ${BASE}`]: () => json(201, { device: env("e3", "Box") }),
      ...guide(DOCKER),
      ...guide(LOCAL),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Docker sandbox/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(within(dialog).getByText("Runs in a container")).toBeTruthy();
    expect(await within(dialog).findByText(DOCKER_GUIDE_TEXT)).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox"), "Box");
    await user.click(within(dialog).getByRole("button", { name: E.create.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/e3"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      name: "Box",
      provider: DOCKER.plugin,
    });
  });

  it("a refused create keeps the dialog open with the error copy", async () => {
    stubApi({
      ...routes,
      [`POST ${BASE}`]: () => json(409, { error: { code: "device.name_taken", message: "taken" } }),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Build box");
    await user.click(within(dialog).getByRole("button", { name: E.create.submit }));
    expect(await within(dialog).findByText(en.errors.device.name_taken)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("device detail", () => {
  beforeEach(() => resetNavigation("/devices/e1"));

  it("device detail first render from hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/devices/e1", routes);
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    // the name is said once: the head is title-less and the nameplate is the page's head
    expect(container.querySelector('[data-part="page-header-title"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Build box" })).toBeTruthy();
    const plate = container.querySelector('[data-part="device-nameplate"]') as HTMLElement;
    expect(within(plate).getByText("Build box")).toBeTruthy();
    expect(screen.getByText(E.detail.filesAndSuspendNote)).toBeTruthy();
    // the nameplate names the provider (its plugin name without a display name)
    expect(plate.textContent).toContain("sandbox-docker");
    await settle();
    expect(browser).toEqual([]);
  });

  it("an unavailable device says its provider is off in this organization", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: env("e1", "Old box", { available: false, provider: "sandbox-gone" }) }),
    });
    await renderDetail({ locale: "zh" });
    expect(
      await screen.findByText(
        "这台设备的设备类型（sandbox-gone）在这个组织里没有启用，文件保留着。",
      ),
    ).toBeTruthy();
  });

  it("the overview shows what the provider reports about the device", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () =>
        json(200, {
          device: env("e1", "Build box", {
            report: {
              revision: "r1",
              description: { en: "A Docker container", zh: "一个 Docker 容器" },
              home: null,
              limits: [],
              reset: true,
            },
          }),
        }),
    });
    await renderDetail();
    expect(await screen.findByText("A Docker container")).toBeTruthy();
  });

  it("device detail: empty cache shows template loading, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/devices/e1", {
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: async () => {
        await held;
        return routes[`GET ${BASE}/e1`]();
      },
    });
    await vi.waitFor(() => expect(template("DetailPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(E.detail.filesAndSuspendNote)).toBeNull();
    await act(async () => release());
    expect(await screen.findByText(E.detail.filesAndSuspendNote)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("an unavailable device shows 不可用 and offers no 重建文件 even when its files are lost", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: env("e1", "Build box", { available: false, filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByText(E.state.unavailable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });

  it("a usable device that lost its files offers 重建文件", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", "Build box", { filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
    // the files are gone: the "kept until deleted" note would contradict the warning
    expect(screen.getByText(E.detail.filesLostNote)).toBeTruthy();
    expect(screen.queryByText(E.detail.filesAndSuspendNote)).toBeNull();
  });

  it("a never-started device's page says 未启动", async () => {
    stubApi(routes);
    await renderDetail();
    expect(await screen.findByText(E.state.notStarted)).toBeTruthy();
  });

  it("a missing device is the not-found state", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(404, { error: { code: "device.not_found", message: "no" } }),
    });
    await renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("rename invalidates the list and the device", async () => {
    const calls = stubApi({
      ...routes,
      [`PATCH ${BASE}/e1`]: () => json(200, { device: env("e1", "Renamed") }),
    });
    const { client } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([env("e1", "Build box")]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.rename }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(within(dialog).getByRole("button", { name: E.detail.renameSubmit }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true),
    );
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ name: "Renamed" });
    // the open device is read again
    await vi.waitFor(() => {
      const names = calls.map((c) => `${c.method} ${c.url}`);
      expect(names.slice(names.indexOf(`PATCH ${BASE}/e1`))).toContain(`GET ${BASE}/e1`);
    });
  });

  it("a cloud network change invalidates the list, the device and its previews", async () => {
    const calls = stubApi({
      ...routes,
      ...NO_PROJECTS,
      [`PATCH ${BASE}/e1`]: () => json(200, { device: env("e1", "Build box") }),
    });
    const { client } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([env("e1", "Build box")]));
    // the composer's cached permission preview of this device
    client.setQueryData(["org", "o1", "device", "e1", "permissionPreview", null], { cached: 1 });
    const user = await openNetwork();
    const group = await screen.findByRole("radiogroup", { name: E.network.title });
    await user.click(
      within(group).getByRole("radio", {
        name: new RegExp(`^${E.network.allowlist}`),
      }),
    );
    await user.click(screen.getByRole("button", { name: E.network.save }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true),
    );
    expect(
      client.getQueryState(["org", "o1", "device", "e1", "permissionPreview", null])?.isInvalidated,
    ).toBe(true);
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      network: { mode: "allowlist", hosts: [] },
    });
    await vi.waitFor(() => {
      const names = calls.map((c) => `${c.method} ${c.url}`);
      expect(names.slice(names.indexOf(`PATCH ${BASE}/e1`))).toContain(`GET ${BASE}/e1`);
    });
  });

  it("delete invalidates devices and forgets the detail once the page is left", async () => {
    const calls = stubApi({ ...routes, [`DELETE ${BASE}/e1`]: () => json(202, {}) });
    const { client, unmount } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([env("e1", "Build box")]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteHint.replace("{name}", "Build box"));
    const confirm = within(dialog).getByRole("button", { name: E.detail.delete });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "Build box");
    await user.click(confirm);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["org", "o1", "device", "e1"])).toBeDefined();
    unmount();
    expect(client.getQueryState(["org", "o1", "device", "e1"])).toBeUndefined();
  });

  it("deleting the default device says a new empty one comes next time", async () => {
    stubApi({ ...NO_PROJECTS, [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", null) }) });
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      E.detail.deleteDefaultHint.replaceAll("{name}", E.personal),
    );
  });

  it("a scheduled file reset polls the device until its files are back", async () => {
    fakePollTimers();
    const lost = env("e1", "Build box", { filesLost: true });
    let reads = 0;
    let posted = false;
    stubApi({
      [`GET ${BASE}`]: () => json(200, list([lost])),
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => {
        if (posted) reads += 1;
        // the job is still running on the first read after the request
        return json(200, { device: reads > 1 ? env("e1", "Build box") : lost });
      },
      [`POST ${BASE}/e1/files/reset`]: () => {
        posted = true;
        return json(202, {});
      },
    });
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.resetFiles }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: E.detail.resetSubmit }));
    expect(
      await screen.findByText(E.detail.resetScheduled.replace("{name}", "Build box")),
    ).toBeTruthy();
    // the first poll still reads the files lost, the second reads them back
    await nextPoll(RESET_POLL_MS);
    await nextPoll(RESET_POLL_MS);
    await vi.waitFor(() => expect(screen.queryByText(E.detail.filesLostNote)).toBeNull());
    expect(reads).toBeGreaterThan(1);
  });

  it("reset files is offered only when the files are lost, and invalidates the device", async () => {
    const lost = env("e1", "Build box", { filesLost: true });
    let reads = 0;
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, list([lost])),
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => {
        reads += 1;
        return json(200, { device: reads > 1 ? env("e1", "Build box") : lost });
      },
      [`POST ${BASE}/e1/files/reset`]: () => json(202, {}),
    });
    const { client } = await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.resetFiles }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: E.detail.resetSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(client.getQueryData(["org", "o1", "device", "e1"])).toBeDefined();
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull(),
    );
  });

  it("no reset button while the files are intact", async () => {
    stubApi(routes);
    await renderDetail();
    await screen.findByText(E.detail.filesAndSuspendNote);
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });
});

describe("local devices (environments spec §6, §9)", () => {
  const MACHINE = {
    id: "m1",
    name: "grant-mbp",
    os: "darwin",
    programVersion: "0.1.0",
    lastSeenAt: T,
  };
  const device = (id: string, name: string, over: Record<string, unknown> = {}) =>
    env(id, name, {
      dialIn: true,
      provider: "device-local",
      providerDisplayName: LOCAL.displayName,
      online: true,
      machine: MACHINE,
      ...over,
    });

  it("devices list marks a dial-in device online from dialIn and online", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, list([device("d1", "Laptop"), device("d2", "Server", { online: false })])),
    });
    await renderList();
    const cards = await screen.findAllByRole("listitem");
    expect(within(cards[0] as HTMLElement).getByText("Local machine")).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByText(E.state.online, { exact: false }),
    ).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText(E.state.offline, { exact: false }),
    ).toBeTruthy();
  });

  it("the list shows each device's provider display name", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([
            env("e1", "Cloud box", {
              provider: "device-e2b",
              providerDisplayName: { zh: "E2B 云端", en: "E2B" },
            }),
          ]),
        ),
    });
    await renderList();
    expect(await screen.findByText("E2B")).toBeTruthy();
  });

  /** The dialog on a list of the given providers, the local one picked. */
  const openLocal = async (items: unknown[] | (() => unknown[])) => {
    fakePollTimers();
    const calls = stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list(typeof items === "function" ? items() : items, {
            providers: [DOCKER, LOCAL],
            defaultProvider: DOCKER.plugin,
          }),
        ),
      ...guide(DOCKER),
      ...guide(LOCAL),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Local machine/ }));
    return { user, dialog, calls };
  };

  it("a dial-in provider: no name field; waits for its new device and opens it", async () => {
    let connected = false;
    const { dialog } = await openLocal(() =>
      connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)],
    );
    expect(await within(dialog).findByText(LOCAL_GUIDE_TEXT)).toBeTruthy();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: E.create.submit })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: E.create.close }).length).toBeGreaterThan(
      0,
    );
    connected = true;
    await nextPoll(WAIT_POLL_MS);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"));
  });

  it("a dial-in provider without a guide says to ask an org admin", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([env("e1", null)], {
            providers: [DOCKER, { ...LOCAL, guide: null }],
            defaultProvider: DOCKER.plugin,
          }),
        ),
      ...guide(DOCKER),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(E.create.noGuide)).toBeNull();
    await user.click(within(dialog).getByRole("radio", { name: /Local machine/ }));
    expect(await within(dialog).findByText(E.create.noGuide)).toBeTruthy();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });

  it("a machine that connects after the window crossed 600 is still detected as new", async () => {
    const win = stubWindowWidth(390);
    let connected = false;
    const { dialog } = await openLocal(() =>
      connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)],
    );
    await within(dialog).findByText(LOCAL_GUIDE_TEXT);
    connected = true;
    win.setWidth(1440);
    await screen.findByText(LOCAL_GUIDE_TEXT);
    win.setWidth(390);
    await nextPoll(WAIT_POLL_MS);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"));
  });

  it("a device that was there when the wait began is not taken as new", async () => {
    let connected = false;
    const { user, dialog, calls } = await openLocal(() =>
      connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)],
    );
    await within(dialog).findByText(LOCAL_GUIDE_TEXT);
    await user.click(within(dialog).getByRole("radio", { name: /Docker sandbox/ }));
    connected = true;
    await user.click(within(dialog).getByRole("radio", { name: /Local machine/ }));
    await within(dialog).findByText(LOCAL_GUIDE_TEXT);
    // a poll after the switch back has read the list that holds d7
    const reads = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
    const before = reads();
    await nextPoll(WAIT_POLL_MS);
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(router.push).not.toHaveBeenCalledWith("/devices/d7");
  });

  it("a login again that replaces a known machine opens its device", async () => {
    let replaced = false;
    const { dialog } = await openLocal(() => [
      env("e1", null),
      device("d7", "grant-mbp", replaced ? { machine: { ...MACHINE, id: "m2" } } : {}),
    ]);
    await within(dialog).findByText(LOCAL_GUIDE_TEXT);
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    replaced = true;
    await nextPoll(WAIT_POLL_MS);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"));
  });

  describe("the shell-action block (连接本机)", () => {
    function installShell(device: Record<string, unknown>) {
      (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
        version: 1,
        capabilities: { "device@2": device },
        on: () => () => {},
      };
    }
    afterEach(() => Reflect.deleteProperty(window, "capybaraShell"));
    const shellDevice = (connect: unknown, connections: unknown[] = []) => ({
      status: vi.fn().mockResolvedValue({ connections }),
      onStatus: () => () => {},
      connect,
    });

    it("in the shell it is a primary button that calls connect({ orgId })", async () => {
      const connect = vi.fn().mockResolvedValue("connected");
      installShell(shellDevice(connect));
      const { user, dialog } = await openLocal([env("e1", null)]);
      const button = await within(dialog).findByRole("button", { name: "Connect this machine" });
      expect(button.getAttribute("data-variant")).toBe("primary");
      await user.click(button);
      expect(connect).toHaveBeenCalledWith({ orgId: "o1" });
    });

    it("an existing connection into this org still offers it (device@2 adds one)", async () => {
      const connection = {
        deviceId: "d7",
        orgId: "o1",
        mode: "os",
        connection: "online",
        serviceInstalled: true,
        keepAwake: { mode: "while-busy", held: false },
      };
      installShell(shellDevice(vi.fn(), [connection]));
      const { dialog } = await openLocal([env("e1", null), device("d7", "grant-mbp")]);
      expect(
        await within(dialog).findByRole("button", { name: "Connect this machine" }),
      ).toBeTruthy();
    });

    it("cancelled leaves the dialog as it was; a failure shows an error", async () => {
      const connect = vi.fn().mockResolvedValue("cancelled");
      installShell(shellDevice(connect));
      const { user, dialog } = await openLocal([env("e1", null)]);
      await user.click(await within(dialog).findByRole("button", { name: "Connect this machine" }));
      await vi.waitFor(() => expect(connect).toHaveBeenCalled());
      await settle();
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      connect.mockRejectedValue({ code: "failed" });
      await user.click(within(dialog).getByRole("button", { name: "Connect this machine" }));
      expect((await within(dialog).findByRole("alert")).textContent).toContain(
        E.create.connectFailed,
      );
    });

    it("a connect answering an error shows an error, never the shell's text", async () => {
      installShell(shellDevice(vi.fn().mockResolvedValue({ error: "login failed" })));
      const { user, dialog } = await openLocal([env("e1", null)]);
      await user.click(await within(dialog).findByRole("button", { name: "Connect this machine" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(E.create.connectFailed);
      expect(alert.textContent).not.toContain("login failed");
    });

    it("in a browser the block renders nothing", async () => {
      const { dialog } = await openLocal([env("e1", null)]);
      await within(dialog).findByText(LOCAL_GUIDE_TEXT);
      expect(within(dialog).queryByRole("button", { name: "Connect this machine" })).toBeNull();
    });
  });

  it("a dial-in device's page names its provider and its machine's version, with no machine block", async () => {
    stubApi({
      [`GET ${BASE}`]: () => json(200, list([device("e1", "Laptop")])),
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop") }),
    });
    await renderDetail();
    const plate = (await screen.findByText("v0.1.0")).closest(
      '[data-part="device-nameplate"]',
    ) as HTMLElement;
    expect(plate.textContent).toContain(LOCAL.displayName.en);
    expect(plate.textContent).toContain(E.state.online);
    // the machine's name is the device's name: never repeated, and no disconnect on the page
    expect(screen.queryByText("grant-mbp")).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
    // the same files note as every other device
    expect(screen.getByText(E.detail.filesAndSuspendNote)).toBeTruthy();
  });

  it("a local device that lost its files offers 重建文件 when its provider's report allows it", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop", { filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByText(E.detail.filesLostNote)).toBeTruthy();
    expect(screen.queryByText(/capybara-device/)).toBeNull();
    expect(screen.getByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("deleting a local device has the same hint as any other", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop") }),
    });
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteHint.replace("{name}", "Laptop"));
  });
});
