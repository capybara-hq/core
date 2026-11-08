// The trajectory pages and the extension pages read from the query cache the layout prefetched
// (web query cache spec §3): first paint complete without a browser read, the loading state on an
// empty cache, the gates, and R5's failures. A trajectory view is audited by the kernel, so a first
// load reads it exactly once; each filter set of the list is its own cache entry.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { fieldOptionLabels, pickOption } from "./support/select";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

const O = "/api/v1/orgs/o1";
const UI = `${O}/ui`;
const T = "2026-10-22T08:00:00.000Z";
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const failing = () => json(500, { error: { code: "internal", message: "x" } });
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

const AGENT = {
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 1,
  definition: { name: "Helper" },
  updatedAt: T,
};
const ITEM = (id: string, title: string | null) => ({
  conversationId: id,
  agentId: "ag1",
  agentName: "Helper",
  accountId: "a2",
  title,
  updatedAt: T,
  lastRun: { runId: `run-${id}`, status: "completed", startedAt: T },
});
const RUN = (runId: string) => ({
  runId,
  agentVersion: 3,
  triggerAccountId: "a1",
  startedAt: T,
  endedAt: T,
  end: { kind: "finished", detail: "completed" },
  steps: [],
  totals: {
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: null,
    modelCalls: 0,
    toolCalls: 0,
    durationMs: 0,
  },
});
const DETAIL = (next: string | null = null) => ({
  conversation: { id: "c1", agentId: "ag1", accountId: "a2", title: "Clean up", kind: "chat" },
  runs: [RUN("r2")],
  currency: "USD",
  next,
});
const BOARD = {
  plugin: "board",
  id: "overview",
  title: { zh: "看板", en: "Board" },
  slot: "org.page",
  kind: "view",
};
const LIVE = { ...BOARD, id: "live", title: { zh: "实时", en: "Live" }, kind: "embed" };

const ROUTES: Routes = {
  [`GET ${O}/members`]: () => json(200, { members: [] }),
  [`GET ${O}/agents`]: () => json(200, { agents: [AGENT] }),
  [`GET ${O}/trajectories`]: () =>
    json(200, { items: [ITEM("c1", "Clean up"), ITEM("c2", null)], next: null }),
  [`GET ${O}/trajectories/c1`]: () => json(200, DETAIL()),
  [`GET ${UI}/contributions`]: () => json(200, { items: [BOARD, LIVE] }),
  [`GET ${UI}/views/board/overview`]: () =>
    json(200, { view: { blocks: [{ type: "heading", text: "Cards" }] } }),
};

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** A client navigation to `path` with an empty cache whose `held` read answers on `release()`. */
async function renderHeld(path: string, held: string, routes: Routes = ROUTES) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  const r = await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { ...r, release: () => act(async () => release()) };
}

beforeEach(() => {
  resetNavigation("/trajectories");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/trajectories", () => {
  it("a first render from the hydrated cache makes no browser read (the first page and the agents)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/trajectories", ROUTES);
    const table = screen.getByRole("table", { name: en.trajectories.title });
    expect(within(table).getByText("Clean up")).toBeTruthy();
    expect(
      fieldOptionLabels(screen.getByRole("combobox", { name: en.trajectories.filters.agent })),
    ).toContain("Helper");
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50`,
    );
    await settle();
    expect(browser).toEqual([]);
  });

  it("the filters come from the query and are read by the layout", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/trajectories?agentId=ag1&status=failed", ROUTES);
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50&agentId=ag1&status=failed`,
    );
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.agent }) as HTMLButtonElement)
        .value,
    ).toBe("ag1");
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.status }) as HTMLButtonElement)
        .value,
    ).toBe("failed");
    await settle();
    expect(browser).toEqual([]);
  });

  it("an unknown status in the query is no filter", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/trajectories?status=bogus", ROUTES);
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50`,
    );
    await settle();
    expect(browser).toEqual([]);
  });

  it("changing a filter is a navigation", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/trajectories?status=failed", ROUTES);
    await pickOption(screen.getByRole("combobox", { name: en.trajectories.filters.agent }), "ag1");
    expect(router.replace).toHaveBeenCalledWith("/trajectories?agentId=ag1&status=failed");
  });

  it("trajectories: a new agent filter never shows the previous filter's rows", async () => {
    const byAgent = (agent: string) =>
      json(200, {
        items: [{ ...ITEM(`c-${agent}`, `Run of ${agent}`), agentId: agent }],
        next: null,
      });
    const { navigate } = await renderRouteWithCache("/trajectories?agentId=a", {
      ...ROUTES,
      [`GET ${O}/trajectories`]: () => byAgent("a"),
    });
    expect(screen.getByText("Run of a")).toBeTruthy();
    // ?agentId=b answers only on release
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const browser = stubApi({
      [`GET ${O}/trajectories`]: async () => {
        await held;
        return byAgent("b");
      },
    });
    resetNavigation("/trajectories?agentId=b");
    await act(() => navigate("/trajectories?agentId=b"));
    await waitFor(() =>
      expect(browser.map((c) => c.url)).toEqual([`${O}/trajectories?limit=50&agentId=b`]),
    );
    // while b loads: none of a's rows, the table's loading state
    expect(screen.queryByText("Run of a")).toBeNull();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Run of b")).toBeTruthy();
    expect(screen.queryByText("Run of a")).toBeNull();
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("a hydrated error of one filter does not keep a new filter from reading", async () => {
    const { navigate } = await renderRouteWithCache("/trajectories?agentId=a", {
      ...ROUTES,
      [`GET ${O}/trajectories`]: failing,
    });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    const browser = stubApi(ROUTES);
    resetNavigation("/trajectories?agentId=b");
    await act(() => navigate("/trajectories?agentId=b"));
    expect(await screen.findByText("Clean up")).toBeTruthy();
    expect(browser.map((c) => c.url)).toEqual([`${O}/trajectories?limit=50&agentId=b`]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/trajectories", `GET ${O}/trajectories`);
    await vi.waitFor(() => {
      if (template("ListPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Clean up")).toBeNull();
    await release();
    expect(await screen.findByText("Clean up")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("agents the kernel fails keep the list (the filter offers what the query names)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/trajectories?agentId=ag9", {
      ...ROUTES,
      [`GET ${O}/agents`]: failing,
    });
    expect(screen.getByRole("table", { name: en.trajectories.title })).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.agent }) as HTMLButtonElement)
        .value,
    ).toBe("ag9");
    await settle();
    expect(browser).toEqual([]);
  });

  it("load more reads the next page in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c3", "Third")], next: null }),
    });
    await renderRouteWithCache("/trajectories", {
      ...ROUTES,
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c1", "Clean up")], next: "c1" }),
    });
    expect(browser).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: en.trajectories.loadMore }));
    expect(await screen.findByText("Third")).toBeTruthy();
    expect(browser.map((c) => c.url)).toEqual([`${O}/trajectories?limit=50&before=c1`]);
  });
});

describe("/trajectories/[conversationId]", () => {
  it("a first render from the hydrated cache makes no browser read (the latest runs, read exactly once: each read is audited)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/trajectories/c1", ROUTES);
    expect(screen.getByRole("tree", { name: en.trajectories.detail.waterfall })).toBeTruthy();
    expect(screen.getByText(en.trajectories.detail.audited)).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith(`${O}/trajectories/c1`)).map((c) => c.url)).toEqual(
      [`${O}/trajectories/c1?limit=10`],
    );
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/trajectories/c1", `GET ${O}/trajectories/c1`);
    await vi.waitFor(() => {
      if (template("TracePage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("tree", { name: en.trajectories.detail.waterfall })).toBeNull();
    await release();
    expect(
      await screen.findByRole("tree", { name: en.trajectories.detail.waterfall }),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("earlier runs load in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/trajectories/c1`]: () => json(200, { ...DETAIL(), runs: [RUN("r1")] }),
    });
    await renderRouteWithCache("/trajectories/c1", {
      ...ROUTES,
      [`GET ${O}/trajectories/c1`]: () => json(200, DETAIL("r2")),
    });
    expect(browser).toEqual([]);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.trajectories.detail.loadEarlier }));
    await waitFor(() =>
      expect(browser.map((c) => c.url)).toEqual([`${O}/trajectories/c1?limit=10&before=r2`]),
    );
  });

  it("a trajectory the kernel hides is the not-found state in the shell", async () => {
    await renderRouteWithCache("/trajectories/c1", {
      ...ROUTES,
      [`GET ${O}/trajectories/c1`]: () =>
        json(404, { error: { code: "trajectory.not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("members the kernel refuses only cost the names; another failure is the error state", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/trajectories/c1", {
      ...ROUTES,
      [`GET ${O}/members`]: () => json(403, { error: { code: "forbidden", message: "x" } }),
    });
    expect(screen.getByRole("tree", { name: en.trajectories.detail.waterfall })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    cleanup();
    stubApi(ROUTES);
    await renderRouteWithCache("/trajectories/c1", { ...ROUTES, [`GET ${O}/members`]: failing });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    await userEvent.setup().click(screen.getByRole("button", { name: en.errors.page.retry }));
    expect(
      await screen.findByRole("tree", { name: en.trajectories.detail.waterfall }),
    ).toBeTruthy();
  });

  it("adding a run to an eval set invalidates that set and the sets list", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`GET ${O}/eval-sets`]: () =>
        json(200, {
          sets: [{ id: "s1", agentId: "ag1", name: "Regression", caseCount: 0, createdAt: T }],
        }),
      [`POST ${O}/eval-sets/s1/cases`]: () => json(201, { case: { id: "k9" } }),
    });
    const { client } = await renderRouteWithCache("/trajectories/c1", ROUTES);
    client.setQueryData(["org", "o1", "evalSet", "s1"], { id: "s1" });
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: en.trajectories.addToSet.action }));
    const dialog = await screen.findByRole("dialog");
    await u.click(
      await within(dialog).findByRole("button", { name: en.trajectories.addToSet.submit }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${O}/eval-sets`,
      `POST ${O}/eval-sets/s1/cases`,
      `GET ${O}/eval-sets`,
    ]);
    expect(client.getQueryState(["org", "o1", "evalSet", "s1"])?.isInvalidated).toBe(true);
  });
});

describe("/p/[plugin]/[id]", () => {
  it("a view: a first render from the hydrated cache makes no browser read (the contribution, then its view); the UI stream opens after", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/p/board/overview", ROUTES);
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
    expect(calls.find((c) => c.url.includes("/views/"))?.url).toBe(
      `${UI}/views/board/overview?locale=en`,
    );
    expect(FakeEventSource.instances.some((s) => s.url === `${UI}/stream`)).toBe(true);
    await settle();
    expect(browser).toEqual([]);
  });

  it("the view's locale is in its key: a zh page reads the zh view", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/p/board/overview", ROUTES, { locale: "zh" });
    expect(calls.find((c) => c.url.includes("/views/"))?.url).toBe(
      `${UI}/views/board/overview?locale=zh`,
    );
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("a view the extension fails draws its own error (not read again on mount) and retry", async () => {
    const browser = stubApi({
      [`GET ${UI}/views/board/overview`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Again" }] } }),
    });
    await renderRouteWithCache("/p/board/overview", {
      ...ROUTES,
      [`GET ${UI}/views/board/overview`]: () =>
        json(502, { error: { code: "ui.render_failed", message: "x" } }),
    });
    expect(screen.getByText(en.errors.ui.render_failed)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("heading", { name: "Again" })).toBeTruthy();
  });

  it("an embed: no view read by the layout; the token handshake stays in the browser", async () => {
    const browser = stubApi({
      [`POST ${UI}/embeds/board/live/token`]: () =>
        json(200, {
          token: "tok-1",
          src: "/plugin-ui/board/live",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          expiresIn: 300,
        }),
    });
    const { calls } = await renderRouteWithCache("/p/board/live", ROUTES);
    expect(calls.some((c) => c.url.includes("/views/"))).toBe(false);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(browser.map((c) => c.url)).toEqual([`${UI}/embeds/board/live/token`]);
  });

  it("an unknown contribution says so", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/p/board/ghost", ROUTES);
    expect(screen.getByText(en.errors.ui.not_found)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/p/board/overview", `GET ${UI}/contributions`);
    await vi.waitFor(() => {
      if (template("DetailPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Cards" })).toBeNull();
    await release();
    expect(await screen.findByRole("heading", { name: "Cards" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});

describe("the gates", () => {
  it("/p/board/overview: a guest may open an extension page", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/p/board/overview", ROUTES, { me: as("guest") });
    expect(noAccess()).toBe(false);
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
  });
});

/** The pages that read through the query cache: path, the role they need (none: any member). */
const ROUTE_GATES: [string, "member" | null][] = [
  ["/trajectories", "member"],
  ["/trajectories/c1", "member"],
  ["/p/board/overview", null],
];

describe("the gates by role", () => {
  it.each(ROUTE_GATES)(
    "%s: below its role no access and nothing read; no org renders nothing; setup goes home",
    async (path, min) => {
      if (min !== null) {
        const denied = await renderRouteWithCache(path, ROUTES, { me: as("guest") });
        expect(new Set(denied.calls.map((c) => c.url))).toEqual(
          new Set(["/api/v1/me", `${O}/readiness`]),
        );
        expect(noAccess()).toBe(true);
        cleanup();
      }
      const none = await renderRouteWithCache(path, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(document.body.textContent).toBe("");
      cleanup();
      expectNoFirstPaintFetch();
      await renderRouteWithCache(path, ROUTES, { readiness: NOT_READY });
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    },
  );
});
