import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
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

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/schedules`;
const T = "2026-11-11T08:00:00.000Z";
const E = en.schedules;
const Z = zh.schedules;

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
  updatedAt: T,
};
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", parameters: [] }],
    },
  ],
};

const task = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  orgId: "o1",
  accountId: "a1",
  agentId: "ag1",
  name: "Daily report",
  prompt: "Summarize yesterday.",
  trigger: { kind: "cron", expr: "0 9 * * 1-5", timeZone: "Asia/Shanghai" },
  mode: "new",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  status: "active",
  pauseReason: null,
  pausedBy: null,
  nextRunAt: "2026-11-12T01:00:12.000Z",
  jitterSeconds: 12,
  expiresAt: null,
  consecutiveFailures: 0,
  lastRun: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  taskId: "s1",
  orgId: "o1",
  scheduledFor: T,
  firedAt: T,
  trial: false,
  conversationId: "c1",
  runId: "run1",
  status: "completed",
  skipReason: null,
  error: null,
  missingGrants: [],
  ...over,
});

const ok = (body: unknown) => () => json(200, body);

const tool = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  title: null,
  source: "builtin",
  connectorId: null,
  grantable: true,
  reason: null,
  ...over,
});
const TOOLS = [
  tool("WebSearch", { title: "Web search" }),
  tool("Bash"),
  tool("mcp__crm__delete", {
    source: "connector",
    connectorId: "c9",
    grantable: false,
    reason: "needs_role",
  }),
  tool("SkillWrite", { grantable: false, reason: "not_grantable" }),
];

/** What the task pages read besides the task itself. */
const common = {
  [`GET ${ORG}/agents`]: ok({ agents: [AGENT] }),
  [`GET ${ORG}/models?kind=chat`]: ok(MODELS),
  [`GET ${ORG}/members`]: ok({
    members: [
      { account: { id: "a1", displayName: "Grant", email: null }, role: "owner", joinedAt: T },
      { account: { id: "a2", displayName: "Mei", email: null }, role: "member", joinedAt: T },
    ],
  }),
  [`GET ${BASE}/chat-targets`]: ok({
    items: [
      {
        connectionId: "cn1",
        connectionName: "Lark bot",
        plugin: "lark",
        agentId: "ag2",
        chatId: "oc_1",
        chatType: "dm",
        label: "Lark bot",
      },
    ],
  }),
  [`GET ${BASE}/grantable-tools?agentId=ag1`]: ok({ items: TOOLS }),
  [`GET ${BASE}/grantable-tools?agentId=ag2`]: ok({ items: TOOLS }),
  [`GET ${ORG}/settings`]: ok({ settings: { toolSearch: "on" } }),
  // my preferences: no zone of my own (the browser's applies)
  "GET /api/v1/me/preferences": ok({ timeZone: null }),
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const actionRow = () => screen.queryByRole("region", { name: "Pending changes" });

beforeEach(() => resetNavigation("/schedules"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/schedules (my scheduled tasks)", () => {
  const routes = {
    ...common,
    [`GET ${BASE}`]: ok({
      items: [
        task(),
        task({
          id: "s2",
          name: "Weekly sync",
          trigger: { kind: "cron", expr: "30 8 * * 1", timeZone: "UTC" },
          status: "paused",
          pauseReason: "failures",
          nextRunAt: null,
          consecutiveFailures: 5,
          lastRun: { status: "failed", skipReason: null, at: T },
        }),
      ],
    }),
  };

  it("lists the tasks from the hydrated cache with no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/schedules", routes);
    expect(template("ListPage")).not.toBeNull();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("Daily report")).toBeTruthy();
    expect(first.getByText("Helper")).toBeTruthy();
    expect(first.getByText("Weekdays at 09:00 (Asia/Shanghai)")).toBeTruthy();
    expect(first.getByText(E.state.active)).toBeTruthy();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText("Every Monday at 08:30 (UTC)")).toBeTruthy();
    expect(second.getByText(E.state.paused.failures)).toBeTruthy();
    expect(second.getByText("Failed 5 times in a row")).toBeTruthy();
    expect(first.getByText(E.noResult)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("zh: the schedule in words and the 定时任务 title", async () => {
    stubApi(routes);
    await renderRouteWithCache("/schedules", routes, { locale: "zh" });
    expect(screen.getByRole("heading", { level: 1, name: Z.title })).toBeTruthy();
    expect(screen.getByText("工作日 09:00（Asia/Shanghai）")).toBeTruthy();
    expect(screen.getByText("每周一 08:30（UTC）")).toBeTruthy();
  });

  it("an empty cache shows the template's loading state, then the rows", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/schedules", {
      ...routes,
      [`GET ${BASE}`]: async () => {
        await held;
        return routes[`GET ${BASE}`]();
      },
    });
    await vi.waitFor(() => expect(template("ListPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Daily report")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Daily report")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("no tasks: the empty state offers a new task", async () => {
    stubApi({ ...common, [`GET ${BASE}`]: ok({ items: [] }) });
    await renderRouteWithCache("/schedules", lastStubRoutes());
    expect(screen.getByText(E.empty)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: E.new }).length).toBeGreaterThan(0);
  });

  it("pausing from the row menu invalidates the list (read again)", async () => {
    let paused = false;
    const calls = stubApi({
      ...common,
      [`GET ${BASE}`]: () =>
        json(200, { items: [task(paused ? { status: "paused", pauseReason: "creator" } : {})] }),
      [`POST ${BASE}/s1/pause`]: () => {
        paused = true;
        return json(200, { task: task({ status: "paused", pauseReason: "creator" }) });
      },
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Row actions" }));
    await user.click(await screen.findByRole("menuitem", { name: E.actions.pause }));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/s1/pause"))).toBe(true);
    expect(await screen.findByText(E.state.paused.creator)).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && c.url === BASE).length).toBeGreaterThan(0);
  });

  it("a guest sees the no-access state and nothing is read", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/schedules", {}, { me: asRole("guest") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("/schedules/new", () => {
  it("creates a task from a preset: cron, browser zone and the approved tools", async () => {
    resetNavigation("/schedules/new");
    const calls = stubApi({
      ...common,
      [`POST ${BASE}`]: () => json(201, { task: task({ id: "s9" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    await renderRouteWithCache("/schedules/new", lastStubRoutes());
    expect(template("FormPage")).not.toBeNull();
    const create = screen.getByRole("button", { name: E.form.create });
    expect(create).toHaveProperty("disabled", true);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: E.form.name }), "Morning brief");
    await user.type(screen.getByRole("textbox", { name: E.form.prompt }), "What's new?");
    await pickOption(
      screen.getByRole("combobox", { name: E.form.preset }),
      E.form.presets.weekdays,
      user,
    );
    // only the grantable tools are offered, by title
    await pickOption(screen.getByRole("combobox", { name: E.form.addTool }), "Web search", user);
    await user.click(screen.getByRole("button", { name: E.form.add }));
    await user.click(screen.getByRole("button", { name: E.form.create }));
    const body = bodyOf(calls.find((c) => c.method === "POST" && c.url === BASE)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      agentId: "ag1",
      name: "Morning brief",
      prompt: "What's new?",
      trigger: { kind: "cron", expr: "0 9 * * 1-5" },
      mode: "new",
      grants: [{ toolKey: "WebSearch" }],
    });
    expect(typeof body.timeZone).toBe("string");
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/schedules/s9"));
  });

  it("a chat target fixes the agent to its connection's and goes in the body", async () => {
    resetNavigation("/schedules/new");
    const calls = stubApi({
      ...common,
      [`GET ${ORG}/agents`]: ok({
        agents: [AGENT, { ...AGENT, id: "ag2", definition: { ...AGENT.definition, name: "Bot" } }],
      }),
      [`POST ${BASE}`]: () => json(201, { task: task({ id: "s9" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    await renderRouteWithCache("/schedules/new", lastStubRoutes());
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: E.form.name }), "Chat brief");
    await user.type(screen.getByRole("textbox", { name: E.form.prompt }), "Go.");
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${E.form.mode.chat}`) }));
    await pickOption(
      screen.getByRole("combobox", { name: E.form.chatTarget }),
      "Lark bot (Direct message)",
      user,
    );
    expect(screen.getByRole("combobox", { name: E.form.agent }).textContent).toContain("Bot");
    // a chat task runs with its conversation's model: no model section
    expect(screen.queryByRole("combobox", { name: E.form.modelLabel })).toBeNull();
    await user.click(screen.getByRole("button", { name: E.form.create }));
    const body = bodyOf(calls.find((c) => c.method === "POST" && c.url === BASE)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      agentId: "ag2",
      mode: "chat",
      chat: { connectionId: "cn1", chatId: "oc_1", chatType: "dm" },
    });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("effort");
  });

  it("the end date is the end of that day in my account's zone; a one-off sends none", async () => {
    resetNavigation("/schedules/new");
    const calls = stubApi({
      ...common,
      "GET /api/v1/me/preferences": ok({ timeZone: "America/New_York" }),
      [`POST ${BASE}`]: () => json(201, { task: task({ id: "s9" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    await renderRouteWithCache("/schedules/new", lastStubRoutes());
    expect(screen.getByText(E.form.zoneCreate.replace("{zone}", "America/New_York"))).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: E.form.name }), "Brief");
    await user.type(screen.getByRole("textbox", { name: E.form.prompt }), "Go.");
    await user.type(
      screen.getByLabelText(new RegExp(`^${E.form.expires}`)) as HTMLInputElement,
      "2026-12-31",
    );
    await user.click(screen.getByRole("button", { name: E.form.create }));
    const posts = () => calls.filter((c) => c.method === "POST" && c.url === BASE);
    // 23:59:59 in New York (EST), whatever the browser's zone
    expect(bodyOf(posts()[0])).toMatchObject({ expiresAt: "2027-01-01T04:59:59.000Z" });

    // the same draft as a one-off: no end date goes out
    resetNavigation("/schedules/new");
    cleanup();
    await renderRouteWithCache("/schedules/new", lastStubRoutes());
    await user.type(screen.getByRole("textbox", { name: E.form.name }), "Once");
    await user.type(screen.getByRole("textbox", { name: E.form.prompt }), "Go.");
    await user.type(
      screen.getByLabelText(new RegExp(`^${E.form.expires}`)) as HTMLInputElement,
      "2026-12-31",
    );
    await pickOption(
      screen.getByRole("combobox", { name: E.form.preset }),
      E.form.presets.once,
      user,
    );
    await user.type(screen.getByLabelText(new RegExp(`^${E.form.at}`)), "2030-01-01T09:00");
    await user.click(screen.getByRole("button", { name: E.form.create }));
    const once = bodyOf(posts()[1]) as Record<string, unknown>;
    expect(once).toMatchObject({ trigger: { kind: "once" } });
    expect(once).not.toHaveProperty("expiresAt");
  });

  it("turned off by the org: a notice and a form that can't create", async () => {
    resetNavigation("/schedules/new");
    stubApi({
      ...common,
      [`GET ${ORG}/settings`]: ok({
        settings: { toolSearch: "on", scheduledTasks: { enabled: false, minIntervalMinutes: 60 } },
      }),
    });
    await renderRouteWithCache("/schedules/new", lastStubRoutes());
    expect(screen.getByText(E.turnedOff)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: E.form.name })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: E.form.create })).toHaveProperty("disabled", true);
    expect(screen.getByText(E.form.minInterval.replace("{n}", "60"))).toBeTruthy();
  });

  it("a guest sees the no-access state", async () => {
    stubApi({});
    await renderRouteWithCache("/schedules/new", {}, { me: asRole("guest") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
  });
});

describe("/schedules/[id]", () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    ...common,
    [`GET ${BASE}/s1`]: ok({ task: task(over) }),
    [`GET ${BASE}/s1/runs`]: ok({
      items: [
        run(),
        run({
          id: "r2",
          status: "skipped",
          skipReason: "overlap",
          conversationId: null,
          firedAt: null,
        }),
        run({ id: "r3", missingGrants: ["Bash", "mcp__crm__delete", "connection:github"] }),
      ],
    }),
    [`GET ${BASE}/s1/grants`]: ok({
      items: [{ toolKey: "WebSearch", specHash: "h", connectorId: null, stale: true }],
    }),
  });

  beforeEach(() => resetNavigation("/schedules/s1"));

  it("renders the task, grants and run history from the cache with no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/schedules/s1", routes());
    expect(template("FormPage")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Daily report" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: E.form.name }) as HTMLInputElement).value).toBe(
      "Daily report",
    );
    const granted = screen.getByRole("list", { name: E.form.toolsLabel });
    expect(granted.textContent).toContain("Web search");
    // the tool changed since it was approved
    expect(within(granted).getByText(E.form.stale)).toBeTruthy();
    // the refused tools the task still lacks: add one, say why another can't be, connect
    const missing = within(screen.getByRole("list", { name: E.form.missingTitle }));
    expect(missing.getAllByRole("button", { name: E.form.addMissing })).toHaveLength(1);
    expect(missing.getByText(E.form.refusal.needs_role)).toBeTruthy();
    expect(missing.getByRole("link", { name: "Connect github" })).toBeTruthy();
    const runs = within(screen.getByRole("table", { name: E.runs.label }));
    expect(runs.getByText(E.runs.skip.overlap)).toBeTruthy();
    expect(runs.getByText("Refused: Bash, mcp__crm__delete, connection:github")).toBeTruthy();
    await settle();
    expect(browser.map((c) => c.url)).toEqual([]);
  });

  it("an empty cache shows the form's loading state, then the task", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const r = routes();
    await renderRouteEmptyCache("/schedules/s1", {
      ...r,
      [`GET ${BASE}/s1`]: async () => {
        await held;
        return r[`GET ${BASE}/s1`]();
      },
    });
    await vi.waitFor(() => expect(template("FormPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("heading", { level: 1, name: "Daily report" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("saving sends only the changed fields and invalidates the task (read again)", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${BASE}/s1`]: (c) =>
        json(200, { task: task({ ...(bodyOf(c) as object), updatedAt: "2026-11-11T09:00:00Z" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules/s1", lastStubRoutes());
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: E.form.name });
    await user.clear(name);
    await user.type(name, "Daily digest");
    await pickOption(screen.getByRole("combobox", { name: E.form.effort }), "High", user);
    expect(actionRow()).not.toBeNull();
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      name: "Daily digest",
      effort: "high",
    });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/s1`).length).toBe(1),
    );
  });

  it("Run now and Trial run post the run; a refused tool is added to the grants", async () => {
    const calls = stubApi({
      ...routes(),
      [`POST ${BASE}/s1/run`]: () => json(202, { run: run({ id: "r9", status: "pending" }) }),
      [`POST ${BASE}/s1/grants`]: (c) =>
        json(200, {
          items: (bodyOf(c) as { grants: { toolKey: string }[] }).grants.map((g) => ({
            ...g,
            specHash: "h",
            connectorId: null,
          })),
        }),
      [`GET ${BASE}`]: ok({ items: [] }),
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules/s1", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: E.actions.runNow }));
    await user.click(screen.getByRole("button", { name: E.actions.trialRun }));
    const runs = calls.filter((c) => c.method === "POST" && c.url.endsWith("/run"));
    expect(runs.map((c) => bodyOf(c))).toEqual([{}, { trial: true }]);
    await user.click(screen.getByRole("button", { name: E.form.addMissing }));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/grants") && c.method === "POST"))).toEqual({
      grants: [{ toolKey: "Bash" }],
    });
  });

  it("delete asks first, then leaves for the list", async () => {
    const calls = stubApi({
      ...routes(),
      [`DELETE ${BASE}/s1`]: () => noContent(),
      [`GET ${BASE}`]: ok({ items: [] }),
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules/s1", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: E.actions.delete }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: E.actions.delete }));
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/s1`)).toBe(true);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/schedules"));
  });

  it("a pause refetch keeps unsaved edits; the form's own save starts over", async () => {
    let state: Record<string, unknown> = {};
    const calls = stubApi({
      ...routes(),
      [`GET ${BASE}/s1`]: () => json(200, { task: task(state) }),
      [`POST ${BASE}/s1/pause`]: () => {
        state = { status: "paused", pauseReason: "creator", updatedAt: "2026-11-11T09:00:00Z" };
        return json(200, { task: task(state) });
      },
      [`PATCH ${BASE}/s1`]: (c) => {
        state = { ...state, ...(bodyOf(c) as object), updatedAt: "2026-11-11T10:00:00Z" };
        return json(200, { task: task(state) });
      },
      [`GET ${BASE}`]: ok({ items: [] }),
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules/s1", lastStubRoutes());
    const user = userEvent.setup();
    const name = screen.getByRole("textbox", { name: E.form.name });
    await user.clear(name);
    await user.type(name, "Unsaved name");
    await user.click(screen.getByRole("button", { name: E.actions.pause }));
    expect(await screen.findByRole("button", { name: E.actions.resume })).toBeTruthy();
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/s1`).length).toBe(1),
    );
    expect((screen.getByRole("textbox", { name: E.form.name }) as HTMLInputElement).value).toBe(
      "Unsaved name",
    );
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ name: "Unsaved name" });
    // saved: the draft starts over from the answer, nothing left to save
    await vi.waitFor(() =>
      expect(
        within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }),
      ).toHaveProperty("disabled", true),
    );
    expect((screen.getByRole("textbox", { name: E.form.name }) as HTMLInputElement).value).toBe(
      "Unsaved name",
    );
  });

  it("an end date is saved as the end of that day in the task zone", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${BASE}/s1`]: (c) =>
        json(200, { task: task({ ...(bodyOf(c) as object), updatedAt: "2026-11-11T09:00:00Z" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
      [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
      [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    });
    await renderRouteWithCache("/schedules/s1", lastStubRoutes());
    const user = userEvent.setup();
    const end = screen.getByLabelText(new RegExp(`^${E.form.expires}`)) as HTMLInputElement;
    await user.type(end, "2026-12-31");
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      expiresAt: "2026-12-31T15:59:59.000Z",
    });
  });

  it("an org admin on another member's task: read-only, pause in the action row, no run", async () => {
    stubApi(routes({ accountId: "a2" }));
    await renderRouteWithCache("/schedules/s1", lastStubRoutes(), { me: asRole("admin") });
    expect(screen.getByText(E.form.readOnly.replace("{name}", "Mei"))).toBeTruthy();
    expect(screen.getByRole("textbox", { name: E.form.name })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: E.actions.runNow })).toBeNull();
    expect(screen.queryByRole("button", { name: E.form.save })).toBeNull();
    expect(screen.getByRole("button", { name: E.actions.pause })).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.form.remove })).toBeNull();
  });

  it("a guest sees the no-access state", async () => {
    stubApi({});
    await renderRouteWithCache("/schedules/s1", {}, { me: asRole("guest") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
  });
});

describe("/settings/schedules (org admins)", () => {
  const S = en.scheduleSettings;
  const SETTINGS = `${ORG}/settings`;
  const settings = {
    toolSearch: "on",
    scheduledTasks: {
      enabled: true,
      minIntervalMinutes: 60,
      maxTasksPerMember: 20,
      maxTasksPerOrg: 200,
      maxRunsPerHour: 60,
      defaultExpiryDays: null,
      catchUpWindowMinutes: 60,
      unattendedAsk: "fail",
      pauseAfterFailures: 5,
      forbiddenTools: [],
    },
  };
  const routes = {
    ...common,
    [`GET ${SETTINGS}`]: ok({ settings }),
    [`GET ${BASE}?all=true`]: ok({ items: [task({ accountId: "a2" })] }),
  };

  beforeEach(() => resetNavigation("/settings/schedules"));

  it("renders the settings and every task from the cache with no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/settings/schedules", routes);
    expect(template("SettingsPage")).not.toBeNull();
    const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
    expect(current?.textContent).toBe(en.connections.nav.schedules);
    const tasks = within(screen.getByRole("table", { name: S.tasks }));
    expect(tasks.getByText("Daily report")).toBeTruthy();
    expect(tasks.getByText("Mei")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the settings' loading state, then the fields", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/settings/schedules", {
      ...routes,
      [`GET ${SETTINGS}`]: async () => {
        await held;
        return json(200, { settings });
      },
    });
    await vi.waitFor(() => expect(template("SettingsPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("textbox", { name: S.maxRunsPerHour })).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "saves the §9 fields through the org settings PATCH, only the changed ones (%s)",
    async (locale) => {
      const s = (locale === "zh" ? zh : en).scheduleSettings;
      const calls = stubApi({
        ...routes,
        [`PATCH ${SETTINGS}`]: (c) => {
          const patch = (bodyOf(c) as { scheduledTasks: object }).scheduledTasks;
          return json(200, {
            settings: { ...settings, scheduledTasks: { ...settings.scheduledTasks, ...patch } },
          });
        },
      });
      await renderRouteWithCache("/settings/schedules", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(screen.getByRole("switch", { name: s.enabled }));
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${s.ask.wait}`) }));
      const runs = screen.getByRole("textbox", { name: s.maxRunsPerHour });
      await user.clear(runs);
      await user.type(runs, "30");
      await user.type(screen.getByRole("textbox", { name: s.defaultExpiryDays }), "90");
      await user.type(
        screen.getByRole("textbox", { name: s.forbiddenTools }),
        "Bash{enter}mcp__github__create_issue",
      );
      const row = screen.getByRole("region", {
        name: locale === "zh" ? "待提交改动" : "Pending changes",
      });
      await user.click(within(row).getByRole("button", { name: s.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        scheduledTasks: {
          enabled: false,
          unattendedAsk: "wait",
          maxRunsPerHour: 30,
          defaultExpiryDays: 90,
          forbiddenTools: ["Bash", "mcp__github__create_issue"],
        },
      });
      expect(await screen.findByText(s.saved)).toBeTruthy();
    },
  );

  it("an invalid number blocks the save", async () => {
    stubApi(routes);
    await renderRouteWithCache("/settings/schedules", lastStubRoutes());
    const user = userEvent.setup();
    const min = screen.getByRole("textbox", { name: S.minIntervalMinutes });
    await user.clear(min);
    await user.type(min, "0");
    expect(screen.getByText(S.invalid)).toBeTruthy();
    expect(within(actionRow() as HTMLElement).getByRole("button", { name: S.save })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("a member sees the no-access state and the settings nav has no 定时任务 item", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/settings/schedules", {}, { me: asRole("member") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});
