// `/conversations` (the compact class's 会话 tab) reads from the query cache the layout prefetched
// (web query cache spec §3): first paint complete without a browser read, the loading state on an
// empty cache, 加载更多 through the groups cursor, the group's own 更多 row and the new action.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, stubApi } from "./support/api";
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
const T = "2026-10-20T06:32:00.000Z";
const C = en.conversations;

const conv = (
  id: string,
  agentId: string,
  title: string | null,
  activity: string | null = null,
) => ({
  id,
  orgId: "o1",
  agentId,
  title,
  titleSource: null,
  deviceId: null,
  activity,
  lastSeq: 1,
  createdAt: T,
  updatedAt: T,
});
const group = (agentId: string, name: string, convs: ReturnType<typeof conv>[], more = false) => ({
  agent: { id: agentId, name, profile: { avatar: null, updatedAt: T } },
  latestAt: T,
  conversations: convs,
  more,
});
const FIRST = {
  groups: [
    group(
      "ag1",
      "Researcher",
      [conv("c1", "ag1", "Industry reports", "running"), conv("c2", "ag1", null)],
      true,
    ),
    group("ag2", "Writer", [conv("c3", "ag2", "Weekly digest", "waiting")]),
  ],
  next: "ag2",
  archivedCount: 0,
};
const ROUTES: Routes = {
  [`GET ${O}/conversations/groups`]: (call) =>
    call.url.includes("after=ag2")
      ? json(200, { groups: [group("ag3", "Planner", [conv("c4", "ag3", "Roadmap")])], next: null })
      : json(200, FIRST),
  [`GET ${O}/conversations`]: () =>
    json(200, { conversations: [conv("c5", "ag1", "Older research")], next: null }),
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/conversations"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/conversations", () => {
  it("a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/conversations", ROUTES);
    const list = screen.getByRole("list", { name: C.list });
    expect(within(list).getByRole("link", { name: "Industry reports" }).getAttribute("href")).toBe(
      "/chat/c1",
    );
    expect(within(list).getByRole("link", { name: "Weekly digest" })).toBeTruthy();
    // an untitled conversation reads its start time
    expect(within(list).getByRole("link", { name: /^Untitled conversation · / })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const answer = ROUTES[`GET ${O}/conversations/groups`];
    if (answer === undefined) throw new Error("no route");
    await renderRouteEmptyCache("/conversations", {
      ...ROUTES,
      [`GET ${O}/conversations/groups`]: async (c) => {
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

  it("marks what runs and what waits, and the primary action starts a new conversation", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    const primary = screen.getByRole("link", { name: C.new });
    expect(primary.getAttribute("href")).toBe("/");
  });

  it("Load more reads the next groups through the cursor; a group's own row reads its older rows", async () => {
    await renderRouteWithCache("/conversations", ROUTES);
    const calls = stubApi(ROUTES);
    const user = userEvent.setup();
    const rowOf = (name: string) =>
      screen
        .getAllByRole("listitem")
        .find((li) => li.querySelector(".cb-object-name")?.textContent === name) as HTMLElement;
    await user.click(within(rowOf(C.loadMore)).getByRole("button", { name: C.loadMore }));
    expect(await screen.findByRole("link", { name: "Roadmap" })).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual([`${O}/conversations/groups?after=ag2`]);
    await user.click(
      within(rowOf("More with Researcher")).getByRole("button", { name: C.loadMore }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Older research" })).not.toBeNull(),
    );
    // the group has no more rows: its row is gone
    expect(rowOf("More with Researcher")).toBeUndefined();
  });
});
