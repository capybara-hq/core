import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { addDays, dayIn, rangeBounds, startOfDay } from "../src/lib/schedule-calendar";
import type { Me } from "../src/lib/session";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

// The document request's cookies, as `page.tsx` reads them (the remembered view).
const req = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(req.cookie ? { cookie: req.cookie } : {}),
}));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/schedules`;
const CAL = `${BASE}/calendar`;
const E = en.schedules;
const C = en.schedules.calendar;
/** The zone the browser (this process) draws in: the server knows it from `cb-tz`. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Thursday 2026-11-12 in most zones (Wednesday or Friday at the far ones: the same week). */
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const TODAY = dayIn(NOW, ZONE);
const WEEK = rangeBounds("week", TODAY, ZONE);
const COOKIES = `cb-tz=${encodeURIComponent(ZONE)}; cap_schedules_view=calendar.week`;

const asRole = (role: "owner" | "admin" | "member" | "guest"): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

const AGENT = {
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 1,
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
  },
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const listTask = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  orgId: "o1",
  accountId: ME.account.id,
  agentId: "ag1",
  name: "Daily report",
  prompt: "Summarize yesterday.",
  trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "America/New_York" },
  mode: "new",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  status: "active",
  pauseReason: null,
  pausedBy: null,
  nextRunAt: "2026-11-13T14:00:12.000Z",
  jitterSeconds: 12,
  expiresAt: null,
  consecutiveFailures: 0,
  lastRun: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const calTask = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "Daily report",
  agentId: "ag1",
  accountId: ME.account.id,
  status: "active",
  pauseReason: null,
  trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "America/New_York" },
  mode: "new",
  jitterSeconds: 12,
  nextRunAt: "2026-11-13T14:00:12.000Z",
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  kind: "run",
  taskId: "s1",
  id: "tr1",
  scheduledFor: "2026-11-10T14:00:00.000Z",
  firedAt: "2026-11-10T14:00:12.000Z",
  status: "completed",
  skipReason: null,
  trial: false,
  manual: false,
  conversationId: "c1",
  error: null,
  missingGrants: 0,
  ...over,
});

const ANSWER = {
  tasks: [calTask()],
  items: [
    run(),
    run({
      id: "tr2",
      scheduledFor: "2026-11-11T14:00:00.000Z",
      firedAt: "2026-11-11T14:00:12.000Z",
      status: "failed",
      error: "model refused",
      conversationId: "c2",
    }),
    {
      kind: "occurrence",
      taskId: "s1",
      scheduledFor: "2026-11-13T14:00:00.000Z",
      at: "2026-11-13T14:00:12.000Z",
    },
  ],
  collapsed: [],
  horizon: "2026-12-24T04:00:00.000Z",
  truncated: false,
};

const ok = (body: unknown) => () => json(200, body);

const routes = (over: Record<string, () => unknown> = {}) => ({
  [`GET ${ORG}/agents`]: ok({ agents: [AGENT] }),
  [`GET ${ORG}/settings`]: ok({ settings: {} }),
  [`GET ${BASE}`]: ok({ items: [listTask()] }),
  [`GET ${CAL}`]: ok(ANSWER),
  [`GET ${ORG}/members`]: ok({
    members: [
      { account: { id: ME.account.id, displayName: "Grant", email: null }, role: "owner" },
      { account: { id: "a2", displayName: "Mei", email: null }, role: "member" },
    ],
  }),
  ...over,
});

/** A document load of `path` with the remembered calendar and the viewer's zone known. */
async function load(path: string, opts: { me?: Me; cookie?: string; locale?: "zh" | "en" } = {}) {
  req.cookie = opts.cookie ?? COOKIES;
  return renderRouteWithCache(path, routes() as never, {
    cookie: req.cookie,
    ...(opts.me ? { me: opts.me } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
}

const grid = () =>
  document.querySelector<HTMLElement>('[data-part="schedule-calendar-grid"]') as HTMLElement;
const block = (id: string) => grid().querySelector<HTMLElement>(`[data-key="i:${id}"]`);
const calendarReads = (calls: { method: string; url: string }[]) =>
  calls
    .filter((c) => c.method === "GET" && c.url.startsWith(CAL))
    .map((c) => Object.fromEntries(new URL(c.url, "http://x").searchParams));
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetNavigation("/schedules");
  window.history.replaceState(null, "", "/schedules");
  // biome-ignore lint/suspicious/noDocumentCookie: the test clears what the page wrote
  document.cookie = "cap_schedules_view=; Max-Age=0; Path=/";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  req.cookie = "";
});

describe("/schedules?view=calendar", () => {
  it("a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await load("/schedules?view=calendar");
    // the server read the shown week in the viewer's zone, mine
    expect(calendarReads(calls)).toEqual([{ ...WEEK, timeZone: ZONE }]);
    expect(screen.getByRole("tab", { name: E.tabs.calendar }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(block("run=tr1")).not.toBeNull();
    expect(block("run=tr2")?.dataset.state).toBe("failed");
    expect(block("at=s1/2026-11-13T14:00:00.000Z")?.dataset.state).toBe("upcoming");
    expect(block("run=tr1")?.getAttribute("aria-label")).toContain("Daily report, Helper,");
    expect(document.body.textContent).toContain(`Times in ${ZONE}.`);
    await settle();
    expect(browser.map((c) => c.url)).toEqual([]);
  });

  it("the cookie restores the calendar on a document load of the bare page", async () => {
    const browser = expectNoFirstPaintFetch();
    await load("/schedules");
    expect(grid()).not.toBeNull();
    expect(block("run=tr1")).not.toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("without the viewer's zone the server reads no range: the view reads it on mount", async () => {
    const calls = stubApi(routes());
    const { calls: server } = await load("/schedules", {
      cookie: "cap_schedules_view=calendar.month",
    });
    expect(calendarReads(server)).toEqual([]);
    await vi.waitFor(() => expect(block("run=tr1")).not.toBeNull());
    expect(calendarReads(calls)).toEqual([
      { ...rangeBounds("month", TODAY, ZONE), timeZone: ZONE },
    ]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    req.cookie = COOKIES;
    await renderRouteEmptyCache(
      "/schedules?view=calendar",
      routes({
        [`GET ${CAL}`]: async () => {
          await held;
          return json(200, ANSWER);
        },
      }) as never,
    );
    await vi.waitFor(() => expect(grid()).not.toBeNull());
    expect(grid().getAttribute("aria-busy")).toBe("true");
    expect(block("run=tr1")).toBeNull();
    await act(async () => release());
    await vi.waitFor(() => expect(block("run=tr1")).not.toBeNull());
    expect(grid().getAttribute("aria-busy")).toBeNull();
  });

  it("the tabs switch without a read and are remembered in the address and the cookie", async () => {
    const calls = stubApi(routes());
    await load("/schedules?view=calendar");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: E.tabs.list }));
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
    expect(window.location.search).toBe("");
    expect(document.cookie).toContain("cap_schedules_view=list.week");
    await user.click(screen.getByRole("tab", { name: E.tabs.calendar }));
    expect(block("run=tr1")).not.toBeNull();
    expect(window.location.search).toBe("?view=calendar");
    expect(document.cookie).toContain("cap_schedules_view=calendar.week");
    await settle();
    expect(calls.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("previous / next change the range read; the month is remembered", async () => {
    const calls = stubApi(routes());
    await load("/schedules?view=calendar");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await vi.waitFor(() => expect(calendarReads(calls)).toHaveLength(1));
    const next = addDays(TODAY, 7);
    expect(calendarReads(calls)[0]).toEqual({ ...rangeBounds("week", next, ZONE), timeZone: ZONE });
    expect(window.location.search).toBe(`?view=calendar&date=${next}`);
    await user.click(screen.getByRole("radio", { name: "Month" }));
    await vi.waitFor(() => expect(calendarReads(calls)).toHaveLength(2));
    expect(calendarReads(calls)[1]).toEqual({
      ...rangeBounds("month", next, ZONE),
      timeZone: ZONE,
    });
    expect(document.cookie).toContain("cap_schedules_view=calendar.month");
  });

  it("a task change elsewhere invalidates the calendar (its key is under schedulesAll)", async () => {
    const calls = stubApi(routes());
    const { client } = await load("/schedules?view=calendar");
    await act(() => client.invalidateQueries({ queryKey: keys.org("o1").schedulesAll() }));
    await vi.waitFor(() => expect(calendarReads(calls).length).toBeGreaterThan(0));
  });

  it("the run panel opens from the hash: my run, its conversation and the task", async () => {
    stubApi(routes());
    window.history.replaceState(null, "", "/schedules?view=calendar#run=tr2");
    await load("/schedules?view=calendar");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Daily report", { selector: "h2" })).toBeTruthy();
    expect(within(sheet).getByText(C.panel.run)).toBeTruthy();
    expect(
      within(sheet).getByRole("link", { name: C.panel.openConversation }).getAttribute("href"),
    ).toBe("/chat/c2");
    expect(within(sheet).getByRole("link", { name: C.panel.openTask }).getAttribute("href")).toBe(
      "/schedules/s1",
    );
    // the task's zone differs from the viewer's (unless the viewer is in New York)
    if (ZONE !== "America/New_York") {
      expect(within(sheet).getByText(/task time zone America\/New_York 11-11 09:00/)).toBeTruthy();
    }
    expect(block("run=tr2")?.dataset.selected).toBe("true");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    // closing drops the hash
    await userEvent.setup().click(within(sheet).getByRole("button", { name: "Close" }));
    expect(window.location.hash).toBe("");
  });

  it("an occurrence opens as planned, with why it may still be skipped", async () => {
    stubApi(routes());
    await load("/schedules?view=calendar");
    await userEvent.setup().click(block("at=s1/2026-11-13T14:00:00.000Z") as HTMLElement);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(C.panel.plannedHint)).toBeTruthy();
    expect(within(sheet).queryByRole("link", { name: C.panel.openConversation })).toBeNull();
    expect(window.location.hash).toBe("#at=s1/2026-11-13T14:00:00.000Z");
  });

  it("a member never sees the scope control", async () => {
    stubApi(routes());
    await load("/schedules?view=calendar&scope=all", { me: asRole("member") });
    expect(screen.queryByRole("radio", { name: C.all })).toBeNull();
  });

  it("an admin switches to the whole org: every task, creators named, no other member's link", async () => {
    const org = {
      ...ANSWER,
      tasks: [...ANSWER.tasks, calTask({ id: "s2", name: "Mei sync", accountId: "a2" })],
      items: [
        ...ANSWER.items,
        run({
          id: "tr9",
          taskId: "s2",
          scheduledFor: "2026-11-12T02:00:00.000Z",
          status: "failed",
          conversationId: null,
          error: null,
          missingGrants: null,
        }),
      ],
    };
    const calls = stubApi(
      routes({
        [`GET ${CAL}`]: () =>
          json(200, calls.at(-1)?.url.includes("all=true") ? org : ANSWER) as never,
        [`GET ${BASE}?all=true`]: ok({
          items: [listTask(), listTask({ id: "s2", accountId: "a2" })],
        }),
      }),
    );
    await load("/schedules?view=calendar", { me: asRole("admin") });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: C.all }));
    await vi.waitFor(() => expect(block("run=tr9")).not.toBeNull());
    expect(calendarReads(calls).at(-1)).toMatchObject({ all: "true" });
    expect(window.location.search).toBe("?view=calendar&scope=all");
    expect(block("run=tr9")?.getAttribute("aria-label")).toContain("Helper · Mei");
    await user.click(block("run=tr9") as HTMLElement);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Mei sync", { selector: "h2" })).toBeTruthy();
    expect(within(sheet).queryByRole("link", { name: C.panel.openConversation })).toBeNull();
    expect(within(sheet).getByText(C.panel.creator)).toBeTruthy();
  });

  it("a cut range warns and draws the rest as not loaded", async () => {
    stubApi(routes());
    req.cookie = COOKIES;
    await renderRouteWithCache(
      "/schedules?view=calendar",
      routes({
        [`GET ${CAL}`]: ok({
          ...ANSWER,
          truncated: true,
          horizon: new Date(startOfDay("2026-11-14", ZONE)).toISOString(),
        }),
      }) as never,
      { cookie: COOKIES },
    );
    expect(document.body.textContent).toContain("Too many runs: shown up to 11-14.");
    expect(grid().textContent).toContain("Not loaded");
  });

  it("an empty week offers the next run", async () => {
    const calls = stubApi(routes());
    req.cookie = COOKIES;
    await renderRouteWithCache(
      "/schedules?view=calendar",
      routes({
        [`GET ${CAL}`]: ok({ ...ANSWER, tasks: [], items: [] }),
        [`GET ${BASE}`]: ok({ items: [listTask({ nextRunAt: "2026-11-20T14:00:12.000Z" })] }),
      }) as never,
      { cookie: COOKIES },
    );
    expect(within(grid()).getByText(C.emptyWeek)).toBeTruthy();
    await userEvent.setup().click(within(grid()).getByRole("button", { name: C.jumpToNext }));
    expect(window.location.search).toContain("date=2026-11-2");
    await vi.waitFor(() => expect(calendarReads(calls)).toHaveLength(1));
  });

  it("every task paused: says so and offers the list", async () => {
    stubApi(routes());
    req.cookie = COOKIES;
    await renderRouteWithCache(
      "/schedules?view=calendar",
      routes({
        [`GET ${CAL}`]: ok({ ...ANSWER, tasks: [], items: [] }),
        [`GET ${BASE}`]: ok({
          items: [listTask({ status: "paused", pauseReason: "creator", nextRunAt: null })],
        }),
      }) as never,
      { cookie: COOKIES },
    );
    expect(within(grid()).getByText(C.allPaused)).toBeTruthy();
    await userEvent.setup().click(within(grid()).getByRole("button", { name: C.showList }));
    expect(screen.getByRole("tab", { name: E.tabs.list }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("zh: 日历 tab, 智能体-free copy and the zone line", async () => {
    stubApi(routes());
    await load("/schedules?view=calendar", { locale: "zh" });
    expect(screen.getByRole("tab", { name: zh.schedules.tabs.calendar })).toBeTruthy();
    expect(document.body.textContent).toContain(`时间按 ${ZONE} 显示。`);
    expect(block("run=tr2")?.getAttribute("aria-label")).toMatch(
      /^Daily report，Helper，11月\d+日 周.+ \d\d:\d\d，失败$/,
    );
  });
});
