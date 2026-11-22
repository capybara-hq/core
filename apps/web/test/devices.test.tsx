import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
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
    json(200, { projects: [], hidden: 0, mode: "auto", base: "/workspace", supported: true }),
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
const env = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
  ownerKind: "personal",
  dialIn: false,
  provider: "sandbox-docker",
  available: true,
  filesLost: false,
  instance: null,
  limits: LIMITS,
  report: null,
  sandbox: SANDBOX,
  createdAt: T,
  ...over,
});
const list = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  defaultId: "e1",
  lastUsedId: null,
  providers: [{ plugin: "sandbox-docker", displayName: null }],
  defaultProvider: "sandbox-docker",
  ...over,
});

const renderList = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices", lastStubRoutes(), opts);
const renderDetail = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices/e1", lastStubRoutes(), opts);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
/** The device page's 设置 tab: every control lives there. */
const settingsTab = () => screen.findByRole("tab", { name: E.detail.tabSettings });
const openSettings = async () => {
  const user = userEvent.setup();
  await user.click(await settingsTab());
  return user;
};
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

beforeEach(() => resetNavigation("/devices"));
afterEach(() => {
  cleanup();
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
    await act(async () => release());
    expect(await screen.findByText("Build box")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("no provider shows the empty state (新建设备 still connects a device)", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, list([], { providers: [], defaultProvider: null, defaultId: null })),
    });
    await renderList();
    expect(await screen.findByText(E.noCloud.text)).toBeTruthy();
    expect(screen.getByText(E.noCloud.hint)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.new })).toBeTruthy();
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
    expect(screen.getByText(E.noCloud.notice)).toBeTruthy();
    expect(screen.queryByText(E.noCloud.text)).toBeNull();
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

  it("新建设备 with two providers offers a provider choice and posts the chosen one", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([env("e1", null)], {
            providers: [
              {
                plugin: "sandbox-docker",
                displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
              },
              { plugin: "sandbox-e2b", displayName: null },
            ],
            defaultProvider: "sandbox-docker",
          }),
        ),
      [`POST ${BASE}`]: () => json(201, { device: env("e3", "Scratch") }),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox", { name: E.create.provider });
    // the default is preselected, by its display name
    expect(within(select).getByText("Docker sandbox")).toBeTruthy();
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "sandbox-e2b" }));
    await user.type(within(dialog).getByRole("textbox"), "Scratch");
    await user.click(within(dialog).getByRole("button", { name: E.create.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/e3"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      name: "Scratch",
      provider: "sandbox-e2b",
    });
  });

  it("with no provider on in the org the cloud option is absent and the local steps remain", async () => {
    stubApi({
      [`GET ${BASE}`]: () => json(200, list([], { providers: [], defaultProvider: null })),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText(E.create.installStep)).toBeTruthy();
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
    // origin and state live in the nameplate alone (the facts rows no longer repeat them)
    expect(screen.getByText(E.source.cloud)).toBeTruthy();
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
      await screen.findByText("此设备的提供方已在本组织关闭或未安装，文件仍保留。"),
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
    const user = await openSettings();
    const group = await screen.findByRole("radiogroup", { name: E.sandbox.network });
    await user.click(
      within(group).getByRole("radio", {
        name: new RegExp(`^${E.sandbox.networkValue.allowlist}`),
      }),
    );
    await user.click(screen.getByRole("button", { name: E.sandbox.save }));
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
    const user = await openSettings();
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
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      E.detail.deleteDefaultHint.replaceAll("{name}", E.personal),
    );
  });

  it("a scheduled file reset polls the device until its files are back", async () => {
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
    await vi.waitFor(() => expect(screen.queryByText(E.detail.filesLostNote)).toBeNull(), {
      timeout: 5000,
    });
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
      provider: "@local",
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
    expect(within(cards[0] as HTMLElement).getByText(E.source.local)).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByText(E.state.online, { exact: false }),
    ).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText(E.state.offline, { exact: false }),
    ).toBeTruthy();
  });

  it("without a cloud sandbox 新建设备 still connects a device", async () => {
    stubApi({
      [`GET ${BASE}`]: () =>
        json(200, list([], { providers: [], defaultProvider: null, defaultId: null })),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    // no choice to make: only 本地设备, its steps at once
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).getByText("npm install -g @capybara-hq/device@next")).toBeTruthy();
  });

  it("新建设备 → 本地设备 shows the steps and waits until the new machine appears", async () => {
    let connected = false;
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list(connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)]),
        ),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
    // each step is a CopyField: its label names the code line holding the command
    const step = (name: string) => within(dialog).getByRole("group", { name });
    expect(step(E.create.installStep).querySelector("code")?.textContent).toBe(
      "npm install -g @capybara-hq/device@next",
    );
    expect(step(E.create.loginStep).querySelector("code")?.textContent).toBe(
      `capybara-device login --url ${window.location.origin}`,
    );
    // login only registers the machine: the third step keeps it online
    expect(step(E.create.startStep).querySelector("code")?.textContent).toBe(
      "capybara-device start",
    );
    expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(3);
    expect(within(dialog).getByText(E.create.waiting)).toBeTruthy();
    connected = true;
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"), {
      timeout: 6000,
    });
  });

  it("a machine that connects after the window crossed 600 is still detected as new", async () => {
    const win = stubWindowWidth(390);
    let connected = false;
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list(connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)]),
        ),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
    await screen.findByText(E.create.waiting);
    // the snapshot (no local device yet) is taken; the machine connects, then the window rotates
    connected = true;
    win.setWidth(1440);
    await screen.findByText(E.create.waiting);
    win.setWidth(390);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"), {
      timeout: 6000,
    });
  });

  it("a machine that connected while the cloud choice was shown is not taken as new", async () => {
    let connected = false;
    const calls = stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list(connected ? [env("e1", null), device("d7", "grant-mbp")] : [env("e1", null)]),
        ),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
    await screen.findByText(E.create.waiting);
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.cloud) }));
    connected = true;
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
    // the wait begins again: the device that is already there is not the new one
    await screen.findByText(E.create.waiting);
    // a poll after the switch back has read the list that holds d7
    const reads = () => calls.filter((c) => c.method === "GET" && c.url === BASE).length;
    const before = reads();
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: 4500 });
    expect(router.push).not.toHaveBeenCalledWith("/devices/d7");
  });

  describe("连接本机 in the desktop shell (desktop client spec §5)", () => {
    const CONNECTED = {
      state: "connected",
      deviceId: "d7",
      orgId: "o1",
      mode: "os",
      connection: "online",
      serviceInstalled: true,
      keepAwake: { mode: "while-busy", held: false },
    };
    function installShell(device: Record<string, unknown>) {
      const listeners = new Set<() => void>();
      (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
        version: 1,
        capabilities: { "device@1": device },
        on: (_e: "change", l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      };
    }
    afterEach(() => Reflect.deleteProperty(window, "capybaraShell"));
    const openLocal = async () => {
      stubApi({ [`GET ${BASE}`]: () => json(200, list([env("e1", null)])) });
      await renderList();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: E.new }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
      return { user, dialog };
    };

    it("not_connected: a primary 连接本机 above the steps; a click calls connect({ orgId })", async () => {
      let onStatus: (s: unknown) => void = () => {};
      const connect = vi.fn().mockResolvedValue("connected");
      installShell({
        status: vi.fn().mockResolvedValue({ state: "not_connected" }),
        onStatus: (l: (s: unknown) => void) => {
          onStatus = l;
          return () => {};
        },
        connect,
      });
      const { user, dialog } = await openLocal();
      const button = await within(dialog).findByRole("button", { name: E.create.connectMachine });
      expect(button.getAttribute("data-variant")).toBe("primary");
      const first = within(dialog).getByText("npm install -g @capybara-hq/device@next");
      expect(button.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await user.click(button);
      expect(connect).toHaveBeenCalledWith({ orgId: "o1" });
      // connected resolves into the wait-for-new-device path: the dialog stays, waiting
      expect(within(dialog).getByText(E.create.waiting)).toBeTruthy();
      expect(onStatus).toBeTypeOf("function");
    });

    it("cancelled leaves the dialog as it was", async () => {
      const connect = vi.fn().mockResolvedValue("cancelled");
      installShell({
        status: vi.fn().mockResolvedValue({ state: "not_connected" }),
        onStatus: () => () => {},
        connect,
      });
      const { user, dialog } = await openLocal();
      await user.click(
        await within(dialog).findByRole("button", { name: E.create.connectMachine }),
      );
      await vi.waitFor(() => expect(connect).toHaveBeenCalled());
      await settle();
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(within(dialog).getByRole("button", { name: E.create.connectMachine })).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("a failed connect shows an error", async () => {
      installShell({
        status: vi.fn().mockResolvedValue({ state: "not_connected" }),
        onStatus: () => () => {},
        connect: vi.fn().mockRejectedValue({ code: "failed" }),
      });
      const { user, dialog } = await openLocal();
      await user.click(
        await within(dialog).findByRole("button", { name: E.create.connectMachine }),
      );
      expect((await within(dialog).findByRole("alert")).textContent).toContain(
        E.create.connectFailed,
      );
    });

    it("connected here: shows the state and a link to the device's page", async () => {
      installShell({
        status: vi.fn().mockResolvedValue(CONNECTED),
        onStatus: () => () => {},
      });
      const { user, dialog } = await openLocal();
      expect(
        await within(dialog).findByText(
          E.create.thisMachineConnected.replace("{state}", E.create.connection.online),
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: E.create.connectMachine })).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: E.create.openDevice }));
      expect(router.push).toHaveBeenCalledWith("/devices/d7");
    });

    it("connected elsewhere: the message and only the terminal steps", async () => {
      installShell({
        status: vi.fn().mockResolvedValue({
          state: "connected_elsewhere",
          origin: "https://other.example",
        }),
        onStatus: () => () => {},
      });
      const { dialog } = await openLocal();
      expect(
        await within(dialog).findByText(
          E.create.connectedElsewhere.replace("{origin}", "https://other.example"),
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: E.create.connectMachine })).toBeNull();
      expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(3);
    });

    it("connected to another org of this person: the note and the terminal steps", async () => {
      installShell({
        status: vi.fn().mockResolvedValue({ ...CONNECTED, orgId: "o2" }),
        onStatus: () => () => {},
      });
      const { dialog } = await openLocal();
      expect(await within(dialog).findByText(E.create.thisMachineOtherOrg)).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: E.create.connectMachine })).toBeNull();
      expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(3);
    });

    it("onStatus refreshes the status", async () => {
      let push: (s: unknown) => void = () => {};
      const status = vi.fn().mockResolvedValue({ state: "not_connected" });
      installShell({
        status,
        onStatus: (l: (s: unknown) => void) => {
          push = l;
          return () => {};
        },
      });
      const { dialog } = await openLocal();
      await within(dialog).findByRole("button", { name: E.create.connectMachine });
      status.mockResolvedValue(CONNECTED);
      act(() => push(CONNECTED));
      expect(await within(dialog).findByRole("button", { name: E.create.openDevice })).toBeTruthy();
    });

    it("in a browser nothing is offered", async () => {
      const { dialog } = await openLocal();
      expect(within(dialog).queryByRole("button", { name: E.create.connectMachine })).toBeNull();
      expect(within(dialog).getAllByRole("button", { name: "Copy" })).toHaveLength(3);
    });
  });

  it("新建设备 → 本地设备 also stops waiting when a login again replaces a known machine", async () => {
    let replaced = false;
    stubApi({
      [`GET ${BASE}`]: () =>
        json(
          200,
          list([
            env("e1", null),
            device("d7", "grant-mbp", replaced ? { machine: { ...MACHINE, id: "m2" } } : {}),
          ]),
        ),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(E.create.local) }));
    expect(within(dialog).getByText(E.create.waiting)).toBeTruthy();
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    replaced = true;
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"), {
      timeout: 6000,
    });
  });

  it("device page shows the machine and revokes it", async () => {
    let revoked = false;
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, list([device("e1", "Laptop")])),
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () =>
        json(200, {
          device: device("e1", "Laptop", revoked ? { machine: null, online: false } : {}),
        }),
      [`DELETE ${BASE}/e1/machine`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    const { client } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([device("e1", "Laptop")]));
    const user = await openSettings();
    expect(await screen.findByText(E.machine.title)).toBeTruthy();
    // origin and state are the nameplate's alone
    expect(screen.getByText(E.source.local)).toBeTruthy();
    expect(screen.getByText(E.state.online)).toBeTruthy();
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    // the machine's name is the device's name, and the nameplate carries its mode: neither is
    // repeated in the machine block, which keeps 系统 and 断开
    expect(screen.queryByText("grant-mbp")).toBeNull();
    // the cloud facts do not apply to a machine
    expect(screen.queryByText(E.detail.filesAndSuspendNote)).toBeNull();
    await user.click(screen.getByRole("button", { name: E.machine.revoke }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: E.machine.revokeSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    // no machine left: the settings tab no longer offers 断开, and the overview has no 机器 block
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: E.machine.revoke })).toBeNull(),
    );
    expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true);
  });

  it("a local device that lost its files says to log out and in again and offers no 重建文件", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop", { filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByText(E.detail.localFilesLostNote)).toBeTruthy();
    expect(E.detail.localFilesLostNote).toContain(
      "capybara-device logout, then capybara-device login",
    );
    expect(screen.queryByText(E.detail.filesLostNote)).toBeNull();
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });

  it("deleting a local device says the files on the machine stay", async () => {
    stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop") }),
    });
    await renderDetail();
    const user = await openSettings();
    await user.click(await screen.findByRole("button", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteLocalHint.replace("{name}", "Laptop"));
  });
});

describe("a dial-in machine's allowlist (read only)", () => {
  it("lists the hosts on 概览 and offers no way to change them from the page", async () => {
    const calls = stubApi({
      ...NO_PROJECTS,
      [`GET ${BASE}/e1`]: () =>
        json(200, {
          device: env("e1", "Laptop", {
            dialIn: true,
            provider: "@local",
            online: true,
            machine: {
              id: "m1",
              name: "grant-mbp",
              os: "darwin",
              programVersion: "0.1.0",
              lastSeenAt: T,
            },
            sandbox: { ...SANDBOX, network: "allowlist", hosts: ["files.example.com"] },
          }),
        }),
    });
    await renderDetail();
    expect(await screen.findByText("files.example.com")).toBeTruthy();
    await openSettings();
    expect(screen.queryByRole("button", { name: /files\.example\.com/ })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/policy"))).toBe(false);
  });
});
