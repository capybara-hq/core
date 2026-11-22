// /extensions and /trajectories declare compact rows: at 390 the rows are grouped (title,
// subtitle, trailing), the extension tabs stay one scrolling row, the trajectory filters move into
// the Filter sheet and later pages are read as the list's end comes into view (spec §4, §6.1).
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { CAPABILITY_TABS } from "../src/lib/extension-capabilities";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
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

const O = "/api/v1/orgs/o1";
const T = "2026-11-01T08:00:00Z";

/** An IntersectionObserver that reports every observed element as in view at once. */
class InView {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  stubWindowWidth(390);
  vi.stubGlobal("IntersectionObserver", InView);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const compact = () => {
  const el = document.querySelector('[data-part="table-compact"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
};

const EXT = {
  plugin: "fancy-ai",
  displayName: { zh: "花式", en: "Fancy AI" },
  version: "1.0.0",
  enabled: true,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [],
  orgConfigSchema: null,
  available: true,
  status: "active",
  provides: ["model-provider@2"],
};

describe("/extensions at 390", () => {
  it("grouped rows: name title, capabilities subtitle, the enable switch trailing", async () => {
    resetNavigation("/extensions");
    const browser = stubApi({
      [`GET ${O}/extensions`]: () => json(200, { extensions: [EXT] }),
      [`PUT ${O}/extensions/fancy-ai`]: (c) =>
        json(200, { extension: { ...EXT, ...(bodyOf(c) as object) } }),
      [`GET ${O}/file-previewers`]: () => json(200, { items: [] }),
      [`GET ${O}/ui/arrangement`]: () => json(200, { slots: [] }),
      [`GET ${O}/extension-points`]: () => json(200, { points: [] }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "en" });
    const table = await vi.waitFor(compact);
    expect(within(table).getByText("Fancy AI", { selector: ".cb-cell-title-name" })).toBeTruthy();
    expect(within(table).getByText("Models")).toBeTruthy();
    const trailing = table.querySelector('[data-part="compact-trailing"]') as HTMLElement;
    const toggle = within(trailing).getByRole("switch", { name: /Fancy AI/ });
    expect(toggle).toBeTruthy();
    // the tabs are still one row (D4): every tab is in the tablist, the first with its count
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs).toHaveLength(["all", ...CAPABILITY_TABS].length);
    expect(tabs[0]?.textContent).toMatch(/1/);
    // an admin's row has one trailing cell (the switch): the state label is in the meta part
    const meta = table.querySelector('[data-part="compact-meta"]') as HTMLElement;
    expect(meta.textContent).toContain(en.extensions.enabled);
    // tapping the switch toggles the extension and does not open the detail (the row tap)
    await userEvent.setup().click(toggle);
    await vi.waitFor(() =>
      expect(bodyOf(browser.find((c) => c.method === "PUT"))).toEqual({ enabled: false }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("/trajectories at 390", () => {
  const ITEM = (id: string, title: string) => ({
    conversationId: id,
    agentId: "ag1",
    agentName: "Helper",
    accountId: "a2",
    title,
    updatedAt: T,
    lastRun: { runId: `run-${id}`, status: "completed", startedAt: T },
  });
  const AGENT = {
    id: "ag1",
    definition: { name: "Helper" },
  };

  it("grouped rows, filters in the Filter sheet, the next page read at the end", async () => {
    resetNavigation("/trajectories");
    const browser = stubApi({
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c3", "Third")], next: null }),
    });
    await renderRouteWithCache("/trajectories", {
      [`GET ${O}/agents`]: () => json(200, { agents: [AGENT] }),
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c1", "Clean up")], next: "c1" }),
    });
    const table = await vi.waitFor(compact);
    expect(within(table).getByText("Clean up")).toBeTruthy();
    expect(within(table).getByText("Helper")).toBeTruthy();
    const trailing = table.querySelector('[data-part="compact-trailing"]') as HTMLElement;
    expect(within(trailing).getByText(en.trajectories.status.completed)).toBeTruthy();
    // no inline filters, no hand-drawn Load more button
    expect(screen.queryByRole("combobox", { name: en.trajectories.filters.agent })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(await screen.findByText("Third")).toBeTruthy();
    expect(browser.map((c) => c.url)).toEqual([`${O}/trajectories?limit=50&before=c1`]);
  });
  it("the Filter button carries the count and the sheet holds both selects", async () => {
    resetNavigation("/trajectories");
    stubApi({});
    await renderRouteWithCache("/trajectories?agentId=ag1&status=failed", {
      [`GET ${O}/agents`]: () => json(200, { agents: [AGENT] }),
      [`GET ${O}/trajectories`]: () => json(200, { items: [ITEM("c1", "Clean up")], next: null }),
    });
    await vi.waitFor(compact);
    expect(screen.queryByRole("combobox")).toBeNull();
    const button = screen.getByRole("button", { name: /^Filters/ });
    expect(button.querySelector('[data-part="filter-count"]')?.textContent).toContain("2");
    await userEvent.setup().click(button);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(en.trajectories.filters.agent)).toBeTruthy();
    expect(within(sheet).getByText(en.trajectories.filters.status)).toBeTruthy();
    expect(within(sheet).getAllByRole("combobox")).toHaveLength(2);
  });
});
