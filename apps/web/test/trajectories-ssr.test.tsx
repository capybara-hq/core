// The trajectory pages and the extension pages render on the server (web-SSR spec §6, task 11):
// first paint complete without a browser fetch, the gates, and R5's failures. A trajectory view is
// audited by the kernel, so the page reads it exactly once.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import PluginPage from "../src/app/(app)/p/[plugin]/[id]/page";
import TrajectoryPage from "../src/app/(app)/trajectories/[conversationId]/page";
import TrajectoriesPage from "../src/app/(app)/trajectories/page";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";
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
  account: { ...ME.account, isEnterpriseAdmin: false },
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
  place: "page",
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

const list =
  (q: Record<string, string> = {}) =>
  () =>
    TrajectoriesPage({ searchParams: Promise.resolve(q) });
const detail = () => TrajectoryPage({ params: Promise.resolve({ conversationId: "c1" }) });
const plugin = (id: string) => () =>
  PluginPage({ params: Promise.resolve({ plugin: "board", id }) });

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
  it("the first page and the agents, with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(list(), ROUTES);
    const table = screen.getByRole("table", { name: en.trajectories.title });
    expect(within(table).getByText("Clean up")).toBeTruthy();
    expect(
      within(screen.getByRole("combobox", { name: en.trajectories.filters.agent })).getByRole(
        "option",
        { name: "Helper" },
      ),
    ).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50`,
    );
    expect(browser).toEqual([]);
  });

  it("the filters come from the query and are read on the server", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(list({ agentId: "ag1", status: "failed" }), ROUTES);
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50&agentId=ag1&status=failed`,
    );
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.agent }) as HTMLSelectElement)
        .value,
    ).toBe("ag1");
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.status }) as HTMLSelectElement)
        .value,
    ).toBe("failed");
    expect(browser).toEqual([]);
  });

  it("an unknown status in the query is no filter", async () => {
    expectNoFirstPaintFetch();
    const { calls } = await renderRoute(list({ status: "bogus" }), ROUTES);
    expect(calls.find((c) => c.url.startsWith(`${O}/trajectories`))?.url).toBe(
      `${O}/trajectories?limit=50`,
    );
  });

  it("changing a filter is a navigation (the server reads the new list)", async () => {
    expectNoFirstPaintFetch();
    await renderRoute(list({ status: "failed" }), ROUTES);
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: en.trajectories.filters.agent }), "ag1");
    expect(router.replace).toHaveBeenCalledWith("/trajectories?agentId=ag1&status=failed");
  });

  it("agents the kernel fails keep the list (the filter offers what the query names)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(list({ agentId: "ag9" }), { ...ROUTES, [`GET ${O}/agents`]: failing });
    expect(screen.getByRole("table", { name: en.trajectories.title })).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: en.trajectories.filters.agent }) as HTMLSelectElement)
        .value,
    ).toBe("ag9");
    expect(browser).toEqual([]);
  });

  it("load more reads the next page in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c3", "Third")], next: null }),
    });
    await renderRoute(list(), {
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
  it("the latest runs, read exactly once (each read is audited), with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(detail, ROUTES);
    expect(screen.getByRole("tree", { name: en.trajectories.detail.waterfall })).toBeTruthy();
    expect(screen.getByText(en.trajectories.detail.audited)).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith(`${O}/trajectories/c1`)).map((c) => c.url)).toEqual(
      [`${O}/trajectories/c1?limit=10`],
    );
    expect(browser).toEqual([]);
  });

  it("earlier runs load in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/trajectories/c1`]: () => json(200, { ...DETAIL(), runs: [RUN("r1")] }),
    });
    await renderRoute(detail, {
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

  it("a trajectory the kernel hides is not found", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(detail, {
        ...ROUTES,
        [`GET ${O}/trajectories/c1`]: () =>
          json(404, { error: { code: "trajectory.not_found", message: "x" } }),
      }),
    ).rejects.toThrow("NOT_FOUND");
  });
});

describe("/p/[plugin]/[id]", () => {
  it("a view: the contribution and its view are read on the server; the UI stream opens after", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(plugin("overview"), ROUTES);
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
    expect(calls.find((c) => c.url.includes("/views/"))?.url).toBe(
      `${UI}/views/board/overview?locale=en`,
    );
    expect(FakeEventSource.instances.some((s) => s.url === `${UI}/stream`)).toBe(true);
    expect(browser).toEqual([]);
  });

  it("a view the extension fails draws its own error and retry", async () => {
    const browser = stubApi({
      [`GET ${UI}/views/board/overview`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Again" }] } }),
    });
    await renderRoute(plugin("overview"), {
      ...ROUTES,
      [`GET ${UI}/views/board/overview`]: () =>
        json(502, { error: { code: "ui.render_failed", message: "x" } }),
    });
    expect(screen.getByText(en.errors.ui.render_failed)).toBeTruthy();
    expect(browser).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("heading", { name: "Again" })).toBeTruthy();
  });

  it("an embed: no view read on the server; the token handshake stays in the browser", async () => {
    const browser = stubApi({
      [`POST ${UI}/embeds/board/live/token`]: () =>
        json(200, {
          token: "tok-1",
          src: "/plugin-ui/board/live",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          expiresIn: 300,
        }),
    });
    const { calls } = await renderRoute(plugin("live"), ROUTES);
    expect(calls.some((c) => c.url.includes("/views/"))).toBe(false);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(browser.map((c) => c.url)).toEqual([`${UI}/embeds/board/live/token`]);
  });

  it("an unknown contribution says so", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(plugin("ghost"), ROUTES);
    expect(screen.getByText(en.errors.ui.not_found)).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

describe("the gates", () => {
  it.each([
    ["/trajectories", list()],
    ["/trajectories/c1", detail],
  ] as const)("%s (members): a guest gets no access and nothing read", async (_p, page) => {
    const denied = await renderRoute(page, ROUTES, { me: as("guest") });
    expect(new Set(denied.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${O}/readiness`]),
    );
    expect(noAccess()).toBe(true);
  });

  it.each([
    ["/trajectories", list()],
    ["/trajectories/c1", detail],
    ["/p/board/overview", plugin("overview")],
  ] as const)("%s: no org renders nothing; setup goes home", async (_p, page) => {
    const none = await renderRoute(page, ROUTES, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    cleanup();
    await expect(renderRoute(page, ROUTES, { readiness: NOT_READY })).rejects.toThrow("REDIRECT /");
  });

  it("/p/board/overview: a guest may open an extension page", async () => {
    expectNoFirstPaintFetch();
    await renderRoute(plugin("overview"), ROUTES, { me: as("guest") });
    expect(noAccess()).toBe(false);
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
  });
});
