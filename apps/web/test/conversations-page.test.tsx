// `/conversations` (All conversations, maintainer decision 2026-11-22): my conversations by time from the query
// cache the layout prefetched (web query cache spec §3), sectioned by day, a chip per agent, the
// next page read as the list's end nears (no Load more row), the new conversation as the head's
// primary and the compact FAB, and a row's actions in an action sheet on a long press / right click.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

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
const C = en.conversations;

// Local calendar days relative to now: the sections follow the viewer's day.
const at = (daysBack: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, daysBack === 0 ? 0 : 30, 0, 0);
  return d.toISOString();
};
const TODAY = at(0, 0);
const YESTERDAY = at(1, 12);
const OLD = at(12, 9);

const NAMES: Record<string, string> = { ag1: "Researcher", ag2: "Writer" };
const conv = (
  id: string,
  agentId: string,
  title: string | null,
  updatedAt: string,
  activity: string | null = null,
) => ({
  id,
  orgId: "o1",
  agentId,
  agent:
    NAMES[agentId] === undefined
      ? null
      : { id: agentId, name: NAMES[agentId], profile: { avatar: null, updatedAt } },
  title,
  titleSource: null,
  deviceId: null,
  activity,
  lastSeq: 1,
  createdAt: updatedAt,
  updatedAt,
});
const group = (agentId: string, name: string) => ({
  agent: { id: agentId, name, profile: { avatar: null, updatedAt: TODAY } },
  latestAt: TODAY,
  conversations: [],
  more: false,
});
const GROUPS = {
  groups: [group("ag1", "Researcher"), group("ag2", "Writer")],
  next: null,
  archivedCount: 0,
};
const FIRST = {
  conversations: [
    conv("c1", "ag1", "Industry reports", TODAY, "running"),
    conv("c2", "ag2", "Weekly digest", YESTERDAY, "waiting"),
    conv("c3", "ag1", null, OLD),
  ],
  next: "c3",
  total: 4,
};
const SECOND = { conversations: [conv("c4", "ag2", "Older research", OLD)], next: null };
const ROUTES: Routes = {
  [`GET ${O}/conversations/groups`]: () => json(200, GROUPS),
  [`GET ${O}/conversations`]: (call) =>
    call.url.includes("after=c3")
      ? json(200, SECOND)
      : call.url.includes("agentId=ag2")
        ? json(200, { conversations: [FIRST.conversations[1]], next: null })
        : // like the kernel: the count comes only when the first page asks for it
          json(200, call.url.includes("withTotal=true") ? FIRST : { ...FIRST, total: undefined }),
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** IntersectionObserver whose targets the test brings into view. */
let observed: { cb: IntersectionObserverCallback; el: Element }[] = [];
class FakeObserver {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.push({ cb: this.cb, el });
  }
  disconnect() {
    observed = observed.filter((o) => o.cb !== this.cb);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
const scrollToEnd = () =>
  act(() => {
    for (const o of observed) {
      o.cb(
        [{ target: o.el, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  });

beforeEach(() => {
  resetNavigation("/conversations");
  observed = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = () => screen.getByRole("region", { name: C.list });

describe("/conversations", () => {
  it("a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/conversations", ROUTES);
    expect(
      within(list())
        .getByRole("link", { name: /Industry reports/ })
        .getAttribute("href"),
    ).toBe("/chat/c1");
    // an untitled conversation reads its start time
    expect(within(list()).getByRole("link", { name: /Untitled conversation · / })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const answer = ROUTES[`GET ${O}/conversations`];
    if (answer === undefined) throw new Error("no route");
    await renderRouteEmptyCache("/conversations", {
      ...ROUTES,
      [`GET ${O}/conversations`]: async (c) => {
        await gate;
        return answer(c);
      },
    });
    await vi.waitFor(() => {
      if (document.querySelector('[data-template="ListPage"]') === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Industry reports")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Industry reports")).toBeTruthy();
  });

  it("lists by time in day sections, each row with its agent, state and time", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const labels = [...list().querySelectorAll('[data-part="convlist-section-label"]')].map(
      (h) => h.textContent,
    );
    expect(labels).toEqual(["Today", "Yesterday", "Earlier"]);
    const today = within(list()).getByRole("region", { name: "Today" });
    const row = within(today).getByRole("link", { name: /Industry reports/ });
    expect(row.textContent).toContain("Researcher");
    expect(row.querySelector('[data-part="convlist-state"]')?.textContent).toBe("Running");
    expect(row.querySelector('[data-part="convlist-time"]')?.textContent).toBe("00:00");
    const waiting = within(list()).getByRole("link", { name: /Weekly digest/ });
    expect(waiting.querySelector('[data-part="convlist-state"]')?.getAttribute("data-tone")).toBe(
      "warn",
    );
    expect(waiting.querySelector('[data-part="convlist-time"]')?.textContent).toBe("Yesterday");
  });

  it("the head: the title with a count, no description; the search and a chip per agent", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const head = document.querySelector('[data-part="page-header"]') as HTMLElement;
    expect(within(head).getByRole("heading", { level: 1 }).textContent).toBe(C.title);
    // more pages to come: the exact total the first page carries
    expect(head.querySelector(".cb-pageheader-count")?.textContent).toBe("4");
    expect(head.querySelector('[data-part="page-header-description"]')).toBeNull();
    expect(within(head).getByRole("searchbox", { name: C.search })).toBeTruthy();
    const chips = screen.getByRole("radiogroup", { name: C.byAgent });
    const chipLabel = (r: HTMLElement) => r.querySelector(".cb-scope-chip-label")?.textContent;
    expect(within(chips).getAllByRole("radio").map(chipLabel)).toEqual([
      C.all,
      "Researcher",
      "Writer",
    ]);
    const calls = stubApi(ROUTES);
    await userEvent.click(within(chips).getByRole("radio", { name: "Writer" }));
    await waitFor(() => expect(within(list()).queryByText("Industry reports")).toBeNull());
    expect(calls.map((c) => c.url)).toContain(
      `${O}/conversations?agentId=ag2&limit=30&withTotal=true`,
    );
  });

  it("rows name their agent themselves: no groups or agents read for the names", async () => {
    await renderRouteWithCache("/conversations", {
      ...ROUTES,
      [`GET ${O}/conversations/groups`]: () => json(200, { groups: [], next: null }),
    });
    const calls = stubApi({ ...ROUTES, [`GET ${O}/agents`]: () => json(200, { agents: [] }) });
    expect(within(list()).getByRole("link", { name: /Industry reports/ }).textContent).toContain(
      "Researcher",
    );
    await settle();
    expect(calls.map((c) => c.url)).not.toContain(`${O}/agents`);
  });

  it("a row whose agent is null reads as its agent id", async () => {
    await renderRouteWithCache("/conversations", {
      ...ROUTES,
      [`GET ${O}/conversations`]: () =>
        json(200, { conversations: [conv("c9", "agX", "Orphan", TODAY)], next: null, total: 1 }),
    });
    expect(within(list()).getByRole("link", { name: /Orphan/ }).textContent).toContain("agX");
  });

  it("reads the next page as the end comes near, with no Load more row", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    const calls = stubApi(ROUTES);
    await scrollToEnd();
    expect(await within(list()).findByRole("link", { name: /Older research/ })).toBeTruthy();
    // a later page asks for no count
    expect(calls.map((c) => c.url)).toEqual([`${O}/conversations?after=c3&limit=30`]);
    // a later page carries no total: the count stays the first page's
    expect(document.querySelector(".cb-pageheader-count")?.textContent).toBe("4");
  });

  it("the primary starts a new conversation: the head's button, restyled as the compact FAB", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const links = screen.getAllByRole("link", { name: C.new });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(links[0]?.closest('[data-head-primary="true"]')).not.toBeNull();
    expect(document.querySelector('[data-template="ListPage"]')?.getAttribute("data-fab")).toBe(
      "true",
    );
  });

  it("a right click (or long press) opens the row's actions in an action sheet", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const calls = stubApi({
      ...ROUTES,
      [`PATCH ${O}/conversations/c1`]: () => json(200, { conversation: FIRST.conversations[0] }),
      [`DELETE ${O}/conversations/c1`]: () => noContent(),
    });
    const row = within(list()).getByRole("link", { name: /Industry reports/ });
    fireEvent.contextMenu(row);
    const sheet = (await waitFor(() => {
      const el = document.querySelector('[data-part="action-sheet"]');
      if (el === null) throw new Error("no sheet");
      return el;
    })) as HTMLElement;
    expect(within(sheet).getByRole("heading").textContent).toBe("Industry reports");
    const items = within(sheet)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-part") === "action-sheet-item");
    expect(items.map((b) => b.textContent)).toEqual(["Rename", "Archive", "Delete"]);
    expect(items[2]?.getAttribute("data-danger")).toBe("true");
    await userEvent.click(items[1] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.url).toBe(`${O}/conversations/c1`),
    );
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ archived: true });
    expect(document.querySelector('[data-part="action-sheet"]')).toBeNull();
  });

  it("a wide window keeps each row's ⋯ menu with the same actions", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const row = within(list())
      .getByRole("link", { name: /Industry reports/ })
      .closest("li");
    const menu = within(row as HTMLElement).getByRole("button", {
      name: "Conversation actions: Industry reports",
    });
    await userEvent.click(menu);
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
});
