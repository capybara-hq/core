import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { expectNoFirstPaintFetch } from "./support/server";

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
const T = "2026-11-07T08:00:00.000Z";
const E = en.devices;

const LIMITS = { cpu: 2, memoryMb: 2048, diskMb: 10240, egress: "allowlist", allowHosts: [] };
const env = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
  demotedFrom: null,
  ownerKind: "personal",
  source: "cloud",
  provider: "sandbox-docker",
  available: true,
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: LIMITS,
  createdAt: T,
  ...over,
});
const list = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  defaultId: "e1",
  lastUsedId: null,
  cloudAvailable: true,
  ...over,
});

const renderList = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices", lastStubRoutes(), opts);
const renderDetail = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/devices/e1", lastStubRoutes(), opts);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
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
        env("e2", "Build box", { sessionIsolation: true, filesLost: true }),
      ]),
    ),
  [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", "Build box") }),
};

describe("devices list", () => {
  it("lists cards: the default is 个人设备, with state and isolation", async () => {
    stubApi(routes);
    const { container } = await renderList();
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const cards = await screen.findAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText(E.personal)).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByText(E.state.running, { exact: false }),
    ).toBeTruthy();
    expect(
      within(cards[0] as HTMLElement).getByText(E.isolation.shared, { exact: false }),
    ).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Build box")).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText(E.state.filesLost, { exact: false }),
    ).toBeTruthy();
    expect(
      within(cards[1] as HTMLElement).getByText(E.isolation.isolated, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Build box" }).getAttribute("href")).toBe(
      "/devices/e2",
    );
  });

  it("a former default is 个人设备（<provider display name>）, the id without one, numbered after the first", async () => {
    const docker = { zh: "Docker 沙箱", en: "Docker sandbox" };
    const former = (id: string, displayName: typeof docker | null, ordinal = 1) =>
      env(id, null, {
        isDefault: false,
        available: false,
        demotedFrom: { provider: "sandbox-docker", displayName, ordinal },
      });
    const items = [
      env("e1", null),
      former("e2", docker),
      former("e3", docker, 2),
      {
        ...former("e4", null),
        demotedFrom: { provider: "sandbox-e2b", displayName: null, ordinal: 1 },
      },
    ];
    stubApi({ [`GET ${BASE}`]: () => json(200, list(items)) });
    await renderList({ locale: "zh" });
    let cards = await screen.findAllByRole("listitem");
    expect(cards.map((c) => c.querySelector("a")?.textContent)).toEqual([
      "个人设备",
      "个人设备（Docker 沙箱）",
      "个人设备（Docker 沙箱） 2",
      "个人设备（sandbox-e2b）",
    ]);
    cleanup();
    stubApi({ [`GET ${BASE}`]: () => json(200, list(items)) });
    await renderList({ locale: "en" });
    cards = await screen.findAllByRole("listitem");
    expect(cards.map((c) => c.querySelector("a")?.textContent)).toEqual([
      "Personal",
      "Personal (Docker sandbox)",
      "Personal (Docker sandbox) 2",
      "Personal (sandbox-e2b)",
    ]);
  });

  it("a former default's page says it comes back with its provider", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, {
          device: env("e1", null, {
            isDefault: false,
            available: false,
            demotedFrom: {
              provider: "sandbox-docker",
              displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
              ordinal: 1,
            },
          }),
        }),
    });
    await renderDetail();
    expect(await screen.findByRole("heading", { name: "Personal (Docker sandbox)" })).toBeTruthy();
    expect(
      screen.getByText(E.detail.demotedNote.replace("{provider}", "Docker sandbox")),
    ).toBeTruthy();
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
      [`GET ${BASE}`]: () => json(200, list([], { cloudAvailable: false, defaultId: null })),
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
            cloudAvailable: false,
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
    expect(bodyOf(post)).toEqual({ name: "Scratch" });
    // the list is read again after the POST (it was invalidated while on screen)
    await vi.waitFor(() => {
      const after = calls.slice(calls.indexOf(post as never)).map((c) => `${c.method} ${c.url}`);
      expect(after).toContain(`GET ${BASE}`);
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
    expect(screen.getAllByText("Build box").length).toBeGreaterThan(0);
    expect(screen.getByText(E.detail.filesNote)).toBeTruthy();
    expect(screen.getByText(E.detail.suspendNote)).toBeTruthy();
    expect(screen.getByText(E.source.cloud)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("device detail: empty cache shows template loading, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/devices/e1", {
      [`GET ${BASE}/e1`]: async () => {
        await held;
        return routes[`GET ${BASE}/e1`]();
      },
    });
    await vi.waitFor(() => expect(template("DetailPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(E.detail.filesNote)).toBeNull();
    await act(async () => release());
    expect(await screen.findByText(E.detail.filesNote)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("an unavailable device shows 不可用 and offers no 重建文件 even when its files are lost", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: env("e1", "Build box", { available: false, filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByText(E.state.unavailable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });

  it("a usable device that lost its files offers 重建文件", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", "Build box", { filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("a never-started device's page says 未启动", async () => {
    stubApi(routes);
    await renderDetail();
    expect(await screen.findByText(E.state.notStarted)).toBeTruthy();
  });

  it("a missing device is the not-found state", async () => {
    stubApi({
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

  it("delete invalidates devices and forgets the detail once the page is left", async () => {
    const calls = stubApi({ ...routes, [`DELETE ${BASE}/e1`]: () => json(202, {}) });
    const { client, unmount } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([env("e1", "Build box")]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: E.detail.delete }));
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
    stubApi({ [`GET ${BASE}/e1`]: () => json(200, { device: env("e1", null) }) });
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: E.detail.delete }));
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
    await screen.findByText(E.detail.filesNote);
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });
});

describe("local devices (environments spec §6, §9)", () => {
  const MACHINE = {
    id: "m1",
    name: "grant-mbp",
    os: "darwin",
    mode: "os",
    programVersion: "0.1.0",
    lastSeenAt: T,
  };
  const device = (id: string, name: string, over: Record<string, unknown> = {}) =>
    env(id, name, {
      source: "local",
      provider: "@local",
      online: true,
      machine: MACHINE,
      ...over,
    });

  it("a device card says 本地设备 and whether its machine is online", async () => {
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
      [`GET ${BASE}`]: () => json(200, list([], { cloudAvailable: false, defaultId: null })),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    // no choice to make: only 本地设备, its steps at once
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(
      within(dialog).getByDisplayValue("npm install -g @capybara-hq/device@next"),
    ).toBeTruthy();
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
    expect(
      within(dialog).getByDisplayValue("npm install -g @capybara-hq/device@next"),
    ).toBeTruthy();
    expect(
      within(dialog).getByDisplayValue(`capybara-device login --url ${window.location.origin}`),
    ).toBeTruthy();
    // login only registers the machine: the third step keeps it online
    expect(within(dialog).getByDisplayValue("capybara-device start")).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: E.create.copy })).toHaveLength(3);
    expect(within(dialog).getByText(E.create.waiting)).toBeTruthy();
    connected = true;
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/devices/d7"), {
      timeout: 6000,
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
    expect(await screen.findByText("grant-mbp")).toBeTruthy();
    expect(screen.getByText(E.source.local)).toBeTruthy();
    expect(screen.getByText(E.state.online)).toBeTruthy();
    expect(screen.getByText("macOS")).toBeTruthy();
    expect(screen.getByText(E.mode.os)).toBeTruthy();
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    // the cloud facts do not apply to a machine
    expect(screen.queryByText(E.detail.suspendNote)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: E.machine.revoke }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: E.machine.revokeSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText(E.machine.none)).toBeTruthy();
    expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true);
  });

  it("a local device that lost its files says to log out and in again and offers no 重建文件", async () => {
    stubApi({
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
    stubApi({ [`GET ${BASE}/e1`]: () => json(200, { device: device("e1", "Laptop") }) });
    await renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteLocalHint.replace("{name}", "Laptop"));
  });
});

describe("device network (network ask-to-allow spec §7)", () => {
  const N = E.network;
  const MACHINE = {
    id: "m1",
    name: "grant-mbp",
    os: "darwin",
    mode: "os",
    programVersion: "0.1.0",
    lastSeenAt: T,
  };
  const policy = (over: Record<string, unknown> = {}) => ({
    effectiveTier: "strict",
    isolation: "sandbox",
    localhost: "off",
    unixSockets: "off",
    allowedDomains: ["files.example.com"],
    remoteGrants: "owner",
    ...over,
  });
  const local = (
    net: { features?: string[]; policy?: unknown; recent?: unknown[] } = {},
    over: Record<string, unknown> = {},
  ) =>
    env("e1", "Laptop", {
      source: "local",
      provider: "@local",
      online: true,
      machine: MACHINE,
      network: {
        features: ["networkReport", "policyOp"],
        policy: policy(),
        recent: [],
        ...net,
      },
      ...over,
    });

  it("removes a domain: the change goes to the machine and the device is read again", async () => {
    let removed = false;
    const calls = stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: local(removed ? { policy: policy({ allowedDomains: [] }) } : {}) }),
      [`POST ${BASE}/e1/policy`]: () => {
        removed = true;
        return json(200, { policy: policy({ allowedDomains: [] }) });
      },
    });
    const { client } = await renderDetail();
    client.setQueryData(["org", "o1", "devices"], list([local()]));
    expect(await screen.findByText("files.example.com")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: N.removeLabel.replace("{host}", "files.example.com") }),
    );
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(bodyOf(post)).toEqual({ remove: ["files.example.com"] });
    expect(await screen.findByText(N.domainsEmpty)).toBeTruthy();
    expect(client.getQueryState(["org", "o1", "devices"])?.isInvalidated).toBe(true);
  });

  it("adds a wildcard domain and refuses an invalid one before sending", async () => {
    const calls = stubApi({
      [`GET ${BASE}/e1`]: () => json(200, { device: local() }),
      [`POST ${BASE}/e1/policy`]: () =>
        json(200, { policy: policy({ allowedDomains: ["files.example.com", "*.slack.com"] }) }),
    });
    await renderDetail();
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: N.add });
    await user.type(input, "https://slack.com");
    await user.click(screen.getByRole("button", { name: N.addSubmit }));
    expect(await screen.findByText(N.hostInvalid)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.clear(input);
    await user.type(input, "*.Slack.com");
    await user.click(screen.getByRole("button", { name: N.addSubmit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ add: ["*.slack.com"] });
  });

  it("turning 不限网络 on asks first with the risk text; turning it off does not", async () => {
    let open = false;
    const calls = stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: local({ policy: policy({ tier: open ? "open" : "strict" }) }) }),
      [`POST ${BASE}/e1/policy`]: (req) => {
        open = (bodyOf(req) as { network: string }).network === "open";
        return json(200, { policy: policy({ tier: open ? "open" : "strict" }) });
      },
    });
    await renderDetail({ locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "不限网络" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "不限网络后，智能体在这台设备上运行的命令可以访问组织允许的任何地址",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "开启不限网络" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ network: "open" });
    await vi.waitFor(() =>
      expect(screen.getByRole("switch", { name: "不限网络" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    // the machine section marks it too
    expect(screen.getAllByText("不限网络").length).toBeGreaterThan(1);
    await user.click(screen.getByRole("switch", { name: "不限网络" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bodyOf(calls.filter((c) => c.method === "POST")[1])).toEqual({ network: "allowlist" });
  });

  it("remoteGrants off disables adding and 不限网络 with the command to run on the machine", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: local({ policy: policy({ remoteGrants: "off" }) }) }),
    });
    await renderDetail();
    expect(await screen.findByText(N.remoteGrantsOffHint)).toBeTruthy();
    expect(screen.getByText(N.remoteGrantsOff)).toBeTruthy();
    expect((screen.getByRole("switch", { name: N.open }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: N.add }) as HTMLInputElement).disabled).toBe(true);
    // narrowing is still accepted
    expect(
      (
        screen.getByRole("button", {
          name: N.removeLabel.replace("{host}", "files.example.com"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("a program without policyOp says to upgrade it; recent changes list who, where and unconfirmed", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, {
          device: local({
            features: ["networkReport"],
            recent: [
              {
                at: T,
                add: ["files.slack.com"],
                remove: [],
                network: null,
                by: "Grant",
                via: "im",
                confirmed: false,
              },
            ],
          }),
        }),
    });
    await renderDetail();
    expect(await screen.findByText(N.upgrade)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove files\.example\.com/ })).toBeNull();
    expect(screen.getByText(N.recent.add.replace("{hosts}", "files.slack.com"))).toBeTruthy();
    expect(screen.getByText(/Grant · IM/)).toBeTruthy();
    expect(screen.getByText(N.recent.unconfirmed)).toBeTruthy();
  });

  it("a refused change shows why with the machine's message", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () => json(200, { device: local() }),
      [`POST ${BASE}/e1/policy`]: () =>
        json(409, {
          error: {
            code: "device.policy_refused",
            message: "change it on the machine: capybara-device policy add allowedDomains a.com",
          },
        }),
    });
    await renderDetail();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: N.add }), "a.com");
    await user.click(screen.getByRole("button", { name: N.addSubmit }));
    expect(await screen.findByText(en.errors.device.policy_refused)).toBeTruthy();
    expect(screen.getByText(/capybara-device policy add allowedDomains a\.com/)).toBeTruthy();
  });

  it("a Docker-mode machine says it has no per-domain control", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { device: local({}, { machine: { ...MACHINE, mode: "docker" } }) }),
    });
    await renderDetail();
    expect(await screen.findByText(N.dockerNote)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: N.add }) as HTMLInputElement).disabled).toBe(true);
  });
});
