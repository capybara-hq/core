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
const BASE = "/api/v1/orgs/o1/environments";
const T = "2026-11-07T08:00:00.000Z";
const E = en.environments;

const LIMITS = { cpu: 2, memoryMb: 2048, diskMb: 10240, egress: "allowlist", allowHosts: [] };
const env = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
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
  renderRouteWithCache("/environments", lastStubRoutes(), opts);
const renderDetail = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/environments/e1", lastStubRoutes(), opts);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

beforeEach(() => resetNavigation("/environments"));
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
  [`GET ${BASE}/e1`]: () => json(200, { environment: env("e1", "Build box") }),
};

describe("environments list", () => {
  it("lists cards: the default is 个人环境, with state and isolation", async () => {
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
      "/environments/e2",
    );
  });

  it("environments list first render from hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    stubApi(routes);
    await renderRouteWithCache("/environments", routes);
    expect(screen.getByText(E.personal)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("empty cache shows template loading, then cards", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/environments", {
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

  it("no provider shows the empty state without 新建环境", async () => {
    stubApi({
      [`GET ${BASE}`]: () => json(200, list([], { cloudAvailable: false, defaultId: null })),
    });
    await renderList();
    expect(await screen.findByText(E.noCloud.text)).toBeTruthy();
    expect(screen.getByText(E.noCloud.hint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.new })).toBeNull();
  });

  it("without a provider the existing environments are still listed as 不可用, with a notice and no 新建环境", async () => {
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
    expect(screen.queryByRole("button", { name: E.new })).toBeNull();
  });

  it("an environment whose instance never started is 未启动", async () => {
    stubApi({ [`GET ${BASE}`]: () => json(200, list([env("e1", "Fresh box")])) });
    await renderList();
    const card = await screen.findByRole("listitem");
    expect(within(card).getByText(E.state.notStarted, { exact: false })).toBeTruthy();
  });

  it("create invalidates environments and opens the new environment", async () => {
    const calls = stubApi({
      ...routes,
      [`POST ${BASE}`]: () => json(201, { environment: env("e3", "Scratch") }),
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
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/environments/e3"));
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
      [`POST ${BASE}`]: () =>
        json(409, { error: { code: "environment.name_taken", message: "taken" } }),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.new }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Build box");
    await user.click(within(dialog).getByRole("button", { name: E.create.submit }));
    expect(await within(dialog).findByText(en.errors.environment.name_taken)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("environment detail", () => {
  beforeEach(() => resetNavigation("/environments/e1"));

  it("environment detail first render from hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/environments/e1", routes);
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    expect(screen.getAllByText("Build box").length).toBeGreaterThan(0);
    expect(screen.getByText(E.detail.filesNote)).toBeTruthy();
    expect(screen.getByText(E.detail.suspendNote)).toBeTruthy();
    expect(screen.getByText(E.source.cloud)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("environment detail: empty cache shows template loading, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/environments/e1", {
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

  it("an unavailable environment shows 不可用 and offers no 重建文件 even when its files are lost", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { environment: env("e1", "Build box", { available: false, filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByText(E.state.unavailable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.detail.resetFiles })).toBeNull();
  });

  it("a usable environment that lost its files offers 重建文件", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(200, { environment: env("e1", "Build box", { filesLost: true }) }),
    });
    await renderDetail();
    expect(await screen.findByRole("button", { name: E.detail.resetFiles })).toBeTruthy();
  });

  it("a never-started environment's page says 未启动", async () => {
    stubApi(routes);
    await renderDetail();
    expect(await screen.findByText(E.state.notStarted)).toBeTruthy();
  });

  it("a missing environment is the not-found state", async () => {
    stubApi({
      [`GET ${BASE}/e1`]: () =>
        json(404, { error: { code: "environment.not_found", message: "no" } }),
    });
    await renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("rename invalidates the list and the environment", async () => {
    const calls = stubApi({
      ...routes,
      [`PATCH ${BASE}/e1`]: () => json(200, { environment: env("e1", "Renamed") }),
    });
    const { client } = await renderDetail();
    client.setQueryData(["org", "o1", "environments"], list([env("e1", "Build box")]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: E.detail.rename }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(within(dialog).getByRole("button", { name: E.detail.renameSubmit }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o1", "environments"])?.isInvalidated).toBe(true),
    );
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ name: "Renamed" });
    // the open environment is read again
    await vi.waitFor(() => {
      const names = calls.map((c) => `${c.method} ${c.url}`);
      expect(names.slice(names.indexOf(`PATCH ${BASE}/e1`))).toContain(`GET ${BASE}/e1`);
    });
  });

  it("delete invalidates environments and forgets the detail once the page is left", async () => {
    const calls = stubApi({ ...routes, [`DELETE ${BASE}/e1`]: () => json(202, {}) });
    const { client, unmount } = await renderDetail();
    client.setQueryData(["org", "o1", "environments"], list([env("e1", "Build box")]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: E.detail.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(E.detail.deleteHint.replace("{name}", "Build box"));
    const confirm = within(dialog).getByRole("button", { name: E.detail.delete });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "Build box");
    await user.click(confirm);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/environments"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(client.getQueryState(["org", "o1", "environments"])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["org", "o1", "environment", "e1"])).toBeDefined();
    unmount();
    expect(client.getQueryState(["org", "o1", "environment", "e1"])).toBeUndefined();
  });

  it("reset files is offered only when the files are lost, and invalidates the environment", async () => {
    const lost = env("e1", "Build box", { filesLost: true });
    let reads = 0;
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, list([lost])),
      [`GET ${BASE}/e1`]: () => {
        reads += 1;
        return json(200, { environment: reads > 1 ? env("e1", "Build box") : lost });
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
    expect(client.getQueryData(["org", "o1", "environment", "e1"])).toBeDefined();
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
