import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import {
  clauseOf,
  type EventSource,
  eventBodyOf,
  eventDraftOf,
  eventDraftValid,
  type FilterRowDraft,
  filterableFacts,
  opsOf,
} from "../src/lib/automations";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { optionLabels, pickOption } from "./support/select";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
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
const BASE = `${ORG}/automations`;
const T = "2026-11-11T08:00:00.000Z";
const E = en.automations;
const Z = zh.automations;

const name = (en: string, zh: string) => ({ en, zh });
const FACTS = {
  status: { type: "string", name: name("Status", "状态"), filterable: true },
  priority: { type: "number", name: name("Priority", "优先级"), filterable: true },
  done: { type: "boolean", name: name("Done", "已完成"), filterable: true },
  labels: { type: "string[]", name: name("Labels", "标签"), filterable: true },
  note: { type: "string", name: name("Note", "备注"), filterable: false },
} as const;
const SOURCE: EventSource = {
  source: "tracker",
  name: name("Tracker", "追踪器"),
  events: [
    {
      type: "item.created",
      name: name("Item created", "条目已创建"),
      directed: false,
      facts: FACTS,
    },
    {
      type: "item.updated",
      name: name("Item updated", "条目已更新"),
      directed: false,
      facts: FACTS,
    },
    {
      type: "item.closed",
      name: name("Item closed", "条目已关闭"),
      directed: false,
      facts: { status: FACTS.status },
    },
    {
      type: "item.assigned",
      name: name("Item assigned", "条目已指派"),
      directed: true,
      facts: FACTS,
    },
  ],
};

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
const ok = (body: unknown) => () => json(200, body);

const common = {
  [`GET ${ORG}/agents`]: ok({ agents: [AGENT] }),
  [`GET ${ORG}/models?kind=chat`]: ok({
    providers: [
      {
        provider: "model-fake",
        models: [{ id: "fake-1", displayName: "Fake 1", parameters: [] }],
      },
    ],
  }),
  [`GET ${ORG}/members`]: ok({ members: [] }),
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
  [`GET ${BASE}/event-sources`]: ok({ items: [SOURCE] }),
  [`GET ${BASE}/grantable-tools?agentId=ag1`]: ok({ items: [] }),
  [`GET ${ORG}/settings`]: ok({
    settings: { toolSearch: "on", automations: { enabled: true, minIntervalMinutes: 60 } },
  }),
  "GET /api/v1/me/preferences": ok({ timeZone: null }),
};

const eventTask = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  orgId: "o1",
  accountId: "a1",
  agentId: "ag1",
  name: "Triage",
  prompt: "Triage the item.",
  trigger: {
    kind: "event",
    source: "tracker",
    types: ["item.created"],
    filter: [{ fact: "status", op: "eq", value: "open" }],
  },
  mode: "subject",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  unattendedAsk: null,
  status: "active",
  pauseReason: null,
  pausedBy: null,
  nextRunAt: null,
  jitterSeconds: 0,
  expiresAt: null,
  consecutiveFailures: 0,
  lastRun: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const actionRow = () => screen.queryByRole("region", { name: "Pending changes" });

beforeEach(() => resetNavigation("/automations/new"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The new form with the trigger switched to events, a name and a prompt typed. */
async function newEventForm(user: ReturnType<typeof userEvent.setup>) {
  await renderRouteWithCache("/automations/new", lastStubRoutes());
  await user.type(screen.getByRole("textbox", { name: E.form.name }), "Triage");
  await user.type(screen.getByRole("textbox", { name: E.form.prompt }), "Triage the item.");
  await user.click(screen.getByRole("radio", { name: E.form.kind.event }));
}

describe("/automations/new: an event trigger", () => {
  it("submits the event trigger, its filter, mode subject and unattendedAsk", async () => {
    const calls = stubApi({
      ...common,
      [`POST ${BASE}`]: () => json(201, { task: eventTask({ id: "e9" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    const user = userEvent.setup();
    await newEventForm(user);
    // the schedule's controls give way to the event ones
    expect(screen.queryByRole("combobox", { name: E.form.preset })).toBeNull();
    const create = screen.getByRole("button", { name: E.form.create });
    // a source and a type are needed
    expect(create).toHaveProperty("disabled", true);
    await pickOption(screen.getByRole("combobox", { name: E.form.eventSource }), "Tracker", user);
    // the directed type is not offered
    expect(screen.getByRole("checkbox", { name: /Item created/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Item assigned/ })).toBeNull();
    expect(create).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: /Item created/ }));
    await user.click(screen.getByRole("checkbox", { name: /Item updated/ }));
    expect(create).toHaveProperty("disabled", false);
    // a filter row: the filterable facts of both types, never the unfilterable one
    await user.click(screen.getByRole("button", { name: E.form.addFilter }));
    const fact = screen.getByRole("combobox", { name: E.form.filterFact });
    expect(await optionLabels(fact, user)).toEqual(["Status", "Priority", "Done", "Labels"]);
    await user.type(screen.getByRole("textbox", { name: E.form.filterValue }), "open");
    // mode: the events' own choice, no chat
    expect(screen.getByRole("radio", { name: new RegExp(`^${E.form.mode.subject}`) })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: new RegExp(`^${E.form.mode.chat}`) })).toBeNull();
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${E.form.mode.subject}`) }));
    await pickOption(
      screen.getByRole("combobox", { name: E.form.unattendedAsk }),
      E.form.ask.wait,
      user,
    );
    await user.click(create);
    const body = bodyOf(calls.find((c) => c.method === "POST" && c.url === BASE));
    expect(body).toEqual({
      agentId: "ag1",
      name: "Triage",
      prompt: "Triage the item.",
      trigger: {
        kind: "event",
        source: "tracker",
        types: ["item.created", "item.updated"],
        filter: [{ fact: "status", op: "eq", value: "open" }],
      },
      mode: "subject",
      unattendedAsk: "wait",
    });
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/automations/e9"));
  });

  it("each fact type has its operators and value; a list fact writes contains", async () => {
    const calls = stubApi({
      ...common,
      [`POST ${BASE}`]: () => json(201, { task: eventTask({ id: "e9" }) }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    const user = userEvent.setup();
    await newEventForm(user);
    await pickOption(screen.getByRole("combobox", { name: E.form.eventSource }), "Tracker", user);
    await user.click(screen.getByRole("checkbox", { name: /Item created/ }));
    const add = () => user.click(screen.getByRole("button", { name: E.form.addFilter }));
    const rows = () =>
      screen.getAllByRole("combobox", { name: E.form.filterFact }).map((el) => {
        const row = el.closest("[data-part='repeater-item']") ?? el.parentElement?.parentElement;
        return row as HTMLElement;
      });
    // a string fact: eq and in; in takes a comma list
    await add();
    await pickOption(
      within(rows()[0] as HTMLElement).getByRole("combobox", { name: E.form.filterOp }),
      E.form.op.in,
      user,
    );
    await user.type(
      within(rows()[0] as HTMLElement).getByRole("textbox", { name: E.form.filterValue }),
      "open, new",
    );
    // a number fact: eq with a number
    await add();
    await pickOption(
      within(rows()[1] as HTMLElement).getByRole("combobox", { name: E.form.filterFact }),
      "Priority",
      user,
    );
    expect(
      await optionLabels(
        within(rows()[1] as HTMLElement).getByRole("combobox", { name: E.form.filterOp }),
        user,
      ),
    ).toEqual([E.form.op.eq]);
    await user.type(
      within(rows()[1] as HTMLElement).getByRole("textbox", { name: E.form.filterValue }),
      "2",
    );
    // a boolean fact: a yes / no choice
    await add();
    await pickOption(
      within(rows()[2] as HTMLElement).getByRole("combobox", { name: E.form.filterFact }),
      "Done",
      user,
    );
    await pickOption(
      within(rows()[2] as HTMLElement).getByRole("combobox", { name: E.form.filterValue }),
      E.form.no,
      user,
    );
    // a list fact: contains only
    await add();
    await pickOption(
      within(rows()[3] as HTMLElement).getByRole("combobox", { name: E.form.filterFact }),
      "Labels",
      user,
    );
    expect(
      await optionLabels(
        within(rows()[3] as HTMLElement).getByRole("combobox", { name: E.form.filterOp }),
        user,
      ),
    ).toEqual([E.form.op.contains]);
    await user.type(
      within(rows()[3] as HTMLElement).getByRole("textbox", { name: E.form.filterValue }),
      "bug",
    );
    await user.click(screen.getByRole("button", { name: E.form.create }));
    const body = bodyOf(calls.find((c) => c.method === "POST" && c.url === BASE)) as {
      trigger: unknown;
    };
    expect(body.trigger).toEqual({
      kind: "event",
      source: "tracker",
      types: ["item.created"],
      filter: [
        { fact: "status", op: "in", value: ["open", "new"] },
        { fact: "priority", op: "eq", value: 2 },
        { fact: "done", op: "eq", value: false },
        { fact: "labels", op: "contains", value: "bug" },
      ],
    });
  });

  it("a row with an empty or mistyped value blocks the create; unchecking a type drops the rows that lose their fact", async () => {
    stubApi({ ...common, [`GET ${BASE}`]: ok({ items: [] }) });
    const user = userEvent.setup();
    await newEventForm(user);
    await pickOption(screen.getByRole("combobox", { name: E.form.eventSource }), "Tracker", user);
    await user.click(screen.getByRole("checkbox", { name: /Item created/ }));
    await user.click(screen.getByRole("checkbox", { name: /Item closed/ }));
    const create = screen.getByRole("button", { name: E.form.create });
    expect(create).toHaveProperty("disabled", false);
    // with `item.closed` selected only `status` is common to both types
    await user.click(screen.getByRole("button", { name: E.form.addFilter }));
    expect(
      await optionLabels(screen.getByRole("combobox", { name: E.form.filterFact }), user),
    ).toEqual(["Status"]);
    // an empty value is no clause: the create waits
    expect(create).toHaveProperty("disabled", true);
    await user.type(screen.getByRole("textbox", { name: E.form.filterValue }), "open");
    expect(create).toHaveProperty("disabled", false);
    // dropping `item.closed` keeps `status`; the row stays
    await user.click(screen.getByRole("checkbox", { name: /Item closed/ }));
    expect(screen.getByRole("textbox", { name: E.form.filterValue })).toBeTruthy();
    // dropping the last type drops the filter
    await user.click(screen.getByRole("checkbox", { name: /Item created/ }));
    expect(screen.queryByRole("textbox", { name: E.form.filterValue })).toBeNull();
  });

  it("switching the trigger keeps the modes apart: a schedule offers chat, never subject", async () => {
    stubApi({ ...common, [`GET ${BASE}`]: ok({ items: [] }) });
    const user = userEvent.setup();
    await renderRouteWithCache("/automations/new", lastStubRoutes());
    const mode = (m: string) => new RegExp(`^${m}`);
    expect(screen.queryByRole("radio", { name: mode(E.form.mode.subject) })).toBeNull();
    expect(screen.getByRole("radio", { name: mode(E.form.mode.chat) })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: E.form.kind.event }));
    await user.click(screen.getByRole("radio", { name: mode(E.form.mode.subject) }));
    // back to a schedule: subject gives way to a new conversation per run
    await user.click(screen.getByRole("radio", { name: E.form.kind.time }));
    expect(screen.queryByRole("radio", { name: mode(E.form.mode.subject) })).toBeNull();
    expect(
      screen.getByRole("radio", { name: mode(E.form.mode.new) }).getAttribute("aria-checked") ??
        (screen.getByRole("radio", { name: mode(E.form.mode.new) }) as HTMLInputElement).checked,
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: E.form.preset })).toBeTruthy();
  });

  it("no event source on in the org: the select says so", async () => {
    stubApi({
      ...common,
      [`GET ${BASE}/event-sources`]: ok({ items: [] }),
      [`GET ${BASE}`]: ok({ items: [] }),
    });
    const user = userEvent.setup();
    await newEventForm(user);
    expect(await screen.findByText(E.form.noEventSources)).toBeTruthy();
    expect(screen.getByRole("button", { name: E.form.create })).toHaveProperty("disabled", true);
  });

  it("zh: 定时 / 事件 and the item mode", async () => {
    stubApi({ ...common, [`GET ${BASE}`]: ok({ items: [] }) });
    await renderRouteWithCache("/automations/new", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: Z.form.kind.event }));
    expect(Z.form.kind.time).toBe("定时");
    expect(Z.form.kind.event).toBe("事件");
    expect(screen.getByRole("radio", { name: new RegExp(`^${Z.form.mode.subject}`) })).toBeTruthy();
    expect(Z.form.mode.subject).toBe("每个事项一条会话");
  });
});

describe("/automations/[id]: an event automation", () => {
  const routes = (task = eventTask()) => ({
    ...common,
    [`GET ${BASE}/e1`]: ok({ task }),
    [`GET ${BASE}/e1/runs`]: ok({ items: [] }),
    [`GET ${BASE}/e1/grants`]: ok({ items: [] }),
    [`GET ${ORG}/inbox`]: ok({ items: [], truncated: false }),
    [`GET ${ORG}/inbox/count`]: ok({ count: 0, more: false }),
    [`GET ${BASE}`]: ok({ items: [] }),
  });
  beforeEach(() => resetNavigation("/automations/e1"));

  it("shows the saved trigger and saves only what changed", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${BASE}/e1`]: (c) =>
        json(200, { task: eventTask(bodyOf(c) as Record<string, unknown>) }),
    });
    await renderRouteWithCache("/automations/e1", lastStubRoutes());
    const user = userEvent.setup();
    expect(screen.getByRole("radio", { name: E.form.kind.event })).toHaveProperty("checked", true);
    // the sources load once the form shows an event trigger
    expect(await screen.findByRole("checkbox", { name: /Item created/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("textbox", { name: E.form.filterValue })).toHaveProperty(
      "value",
      "open",
    );
    // nothing changed yet: nothing to save
    expect(
      within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }),
    ).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: /Item updated/ }));
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      trigger: {
        kind: "event",
        source: "tracker",
        types: ["item.created", "item.updated"],
        filter: [{ fact: "status", op: "eq", value: "open" }],
      },
    });
  });

  it("unattendedAsk is saved, and null clears it back to the org default", async () => {
    const calls = stubApi({
      ...routes(eventTask({ unattendedAsk: "fail" })),
      [`PATCH ${BASE}/e1`]: (c) =>
        json(200, { task: eventTask(bodyOf(c) as Record<string, unknown>) }),
    });
    await renderRouteWithCache("/automations/e1", lastStubRoutes());
    const user = userEvent.setup();
    await pickOption(
      screen.getByRole("combobox", { name: E.form.unattendedAsk }),
      E.form.orgDefault,
      user,
    );
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ unattendedAsk: null });
  });

  it("switching to a schedule sends the trigger with a zone, and the mode that fits it", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${BASE}/e1`]: (c) =>
        json(200, { task: eventTask(bodyOf(c) as Record<string, unknown>) }),
    });
    await renderRouteWithCache("/automations/e1", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: E.form.kind.time }));
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: E.form.save }));
    const patch = bodyOf(calls.find((c) => c.method === "PATCH")) as Record<string, unknown>;
    expect(patch).toMatchObject({
      trigger: { kind: "cron", expr: "0 9 * * *" },
      mode: "new",
    });
    expect(typeof patch.timeZone).toBe("string");
  });
});

describe("/settings/automations: event automations", () => {
  const S = en.automationSettings;
  const SETTINGS = `${ORG}/settings`;
  const settings = {
    toolSearch: "on",
    automations: {
      enabled: true,
      minIntervalMinutes: 60,
      maxTasksPerMember: 20,
      maxTasksPerOrg: 200,
      maxRunsPerHour: 60,
      defaultExpiryDays: null,
      catchUpWindowMinutes: 60,
      unattendedAsk: "fail",
      pauseAfterFailures: 5,
      maxEventDepth: 8,
      coalesceSeconds: 30,
      maxEventRunsPerSubjectPerHour: 12,
      eventSourcesOff: ["old-source"],
      forbiddenTools: [],
    },
  };
  const routes = {
    ...common,
    [`GET ${SETTINGS}`]: ok({ settings }),
    [`GET ${BASE}?all=true`]: ok({ items: [] }),
  };
  beforeEach(() => resetNavigation("/settings/automations"));

  it("one section holds the event numbers and the sources; only the changed fields are saved", async () => {
    const calls = stubApi({
      ...routes,
      [`PATCH ${SETTINGS}`]: (c) => {
        const patch = (bodyOf(c) as { automations: object }).automations;
        return json(200, {
          settings: { ...settings, automations: { ...settings.automations, ...patch } },
        });
      },
    });
    await renderRouteWithCache("/settings/automations", lastStubRoutes());
    await settle();
    expect(screen.getByRole("textbox", { name: S.maxEventDepth })).toHaveProperty("value", "8");
    expect(screen.getByRole("textbox", { name: S.coalesceSeconds })).toHaveProperty("value", "30");
    // the sources of the org, and one turned off earlier that is no longer listed
    const tracker = screen.getByRole("checkbox", { name: "Tracker" });
    expect(tracker).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: "old-source" })).toHaveProperty("checked", false);
    const user = userEvent.setup();
    const depth = screen.getByRole("textbox", { name: S.maxEventDepth });
    await user.clear(depth);
    await user.type(depth, "4");
    await user.click(tracker);
    await user.click(screen.getByRole("checkbox", { name: "old-source" }));
    await user.click(within(actionRow() as HTMLElement).getByRole("button", { name: S.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      automations: { maxEventDepth: 4, eventSourcesOff: ["tracker"] },
    });
  });

  it("a chain depth past the kernel's bound blocks the save", async () => {
    stubApi(routes);
    await renderRouteWithCache("/settings/automations", lastStubRoutes());
    const user = userEvent.setup();
    const depth = screen.getByRole("textbox", { name: S.maxEventDepth });
    await user.clear(depth);
    await user.type(depth, "1001");
    expect(screen.getByText(S.invalid)).toBeTruthy();
    expect(within(actionRow() as HTMLElement).getByRole("button", { name: S.save })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("event filter helpers", () => {
  const row = (over: Partial<FilterRowDraft>): FilterRowDraft => ({
    key: "k",
    fact: "status",
    factType: "string",
    op: "eq",
    value: "open",
    ...over,
  });

  it("clauseOf writes the clause the kernel's validateFilter accepts, or null", () => {
    expect(clauseOf(row({}))).toEqual({ fact: "status", op: "eq", value: "open" });
    expect(clauseOf(row({ op: "in", value: " a, b ,a,, " }))).toEqual({
      fact: "status",
      op: "in",
      value: ["a", "b"],
    });
    expect(clauseOf(row({ factType: "number", value: "-2.5" }))).toEqual({
      fact: "status",
      op: "eq",
      value: -2.5,
    });
    expect(clauseOf(row({ factType: "number", value: "two" }))).toBeNull();
    expect(clauseOf(row({ factType: "boolean", value: "true" }))).toEqual({
      fact: "status",
      op: "eq",
      value: true,
    });
    expect(clauseOf(row({ factType: "boolean", value: "yes" }))).toBeNull();
    expect(clauseOf(row({ factType: "string[]", op: "contains", value: "bug" }))).toEqual({
      fact: "status",
      op: "contains",
      value: "bug",
    });
    expect(clauseOf(row({ value: "  " }))).toBeNull();
    expect(clauseOf(row({ op: "in", value: " , " }))).toBeNull();
    expect(clauseOf(row({ fact: "" }))).toBeNull();
  });

  it("opsOf and filterableFacts follow the declarations", () => {
    expect(opsOf("string")).toEqual(["eq", "in"]);
    expect(opsOf("number")).toEqual(["eq"]);
    expect(opsOf("boolean")).toEqual(["eq"]);
    expect(opsOf("string[]")).toEqual(["contains"]);
    expect(filterableFacts(SOURCE, ["item.created"]).map((f) => f.fact)).toEqual([
      "status",
      "priority",
      "done",
      "labels",
    ]);
    expect(filterableFacts(SOURCE, ["item.created", "item.closed"]).map((f) => f.fact)).toEqual([
      "status",
    ]);
    // a directed type is not one to select
    expect(filterableFacts(SOURCE, ["item.assigned"])).toEqual([]);
    expect(filterableFacts(undefined, ["item.created"])).toEqual([]);
  });

  it("a saved trigger reads back into rows and writes the same body", () => {
    const trigger = {
      kind: "event" as const,
      source: "tracker",
      types: ["item.created"],
      filter: [
        { fact: "status", op: "in" as const, value: ["a", "b"] },
        { fact: "priority", op: "eq" as const, value: 3 },
        { fact: "done", op: "eq" as const, value: false },
        { fact: "labels", op: "contains" as const, value: "bug" },
      ],
    };
    const draft = eventDraftOf(trigger);
    expect(draft.filter.map((r) => [r.factType, r.value])).toEqual([
      ["string", "a, b"],
      ["number", "3"],
      ["boolean", "false"],
      ["string[]", "bug"],
    ]);
    expect(eventDraftValid(draft)).toBe(true);
    expect(eventBodyOf(draft)).toEqual(trigger);
    expect(eventDraftValid({ ...draft, types: [] })).toBe(false);
    expect(eventDraftValid({ ...draft, source: "" })).toBe(false);
  });
});
