import { randomUUID } from "node:crypto";
import type { TriggerEvent, TriggerSource, TriggerSubject } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_PROMPT, AcceptanceService } from "../../src/automations/events/acceptance.js";
import { EventCoalescer } from "../../src/automations/events/coalesce.js";
import { TriggerDispatcher } from "../../src/automations/events/dispatcher.js";
import { subjectKey } from "../../src/automations/events/guards.js";
import { TriggerEventSweepJob } from "../../src/automations/events/sweep.job.js";
import { AutomationFirer } from "../../src/automations/fire.js";
import { AUTOMATION_SCAN_JOB, TRIGGER_EVENT_SWEEP_JOB } from "../../src/automations/job-ids.js";
import { unattendedRunOf } from "../../src/automations/unattended.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Directed events and acceptance (collaboration spec §4.4): a directed event (`audience`: a person
 * and their agent) is routed by the person's acceptance rule for its source, else the org's
 * `directedDefault` (default `auto`). `auto` makes (once) and fires the person's acceptance
 * automation; `confirm` posts a work offer the person accepts (the work runs) or declines (the
 * person who caused it is told); `off` runs nothing. The tests call the dispatcher and the
 * coalescer directly while outbox adds to the maintenance queue fail, so owed rows stay.
 */

const PLUGIN = "fake-trigger-source";
const ITEM: TriggerSubject = { kind: "item", id: "ITEM-1", title: "First item" };
const OTHER: TriggerSubject = { kind: "item", id: "ITEM-2", title: "Second item" };

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ownerId: string;
let member: Req;
let memberId: string;
let orgId: string;
let agentId: string;
let seq = 0;

interface Probe {
  visible?: string[];
  emit?: (e: TriggerEvent) => Promise<{ eventId: string; duplicate: boolean }>;
}
const probe = () => {
  const g = globalThis as { __fakeTriggerSource?: Probe };
  g.__fakeTriggerSource ??= {};
  return g.__fakeTriggerSource;
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)],
        auth: { cookieSecure: false },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
  // the tests own the sweep and fire runs themselves
  k.app.get(SchedulerRegistry).getCronJob(TRIGGER_EVENT_SWEEP_JOB).stop();
  k.app.get(SchedulerRegistry).getCronJob(AUTOMATION_SCAN_JOB).stop();
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function newAgent(req: Req, name: string, visibility = "org"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Work.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeEach(async () => {
  delete probe().visible;
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.outbox");
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Olga" })).id;
  memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "Mo" })).id;
  owner = await session(k, "owner");
  member = await session(k, "member");
  orgId = await createOrgWithProviders(k, owner, "Acme");
  await db
    .insertInto("memberships")
    .values({ org_id: orgId, account_id: memberId, role: "member" })
    .execute();
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
  agentId = await newAgent(owner, "Watcher");
});

/** Emits an `item.assigned` event for the owner and their agent; returns the event id. */
async function assign(over: Partial<TriggerEvent> = {}): Promise<string> {
  const fn = probe().emit;
  if (!fn) throw new Error("fake-trigger-source did not set up");
  const r = await fn({
    orgId,
    type: "item.assigned",
    subject: ITEM,
    facts: { status: "open" },
    summary: "Item ITEM-1 was assigned to you.",
    dedupeKey: `key-${++seq}`,
    audience: { accountId: ownerId, agentId },
    cause: { accountId: memberId },
    ...over,
  });
  return r.eventId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The fake source's provider object, as the kernel gets it. */
async function sourceImpl(): Promise<TriggerSource> {
  const { providers } = await k.app
    .get(ExtensionPointDefaults)
    .providersFor<TriggerSource>(orgId, "trigger-source");
  const impl = providers.find((p) => p.extension === PLUGIN)?.impl;
  if (!impl) throw new Error("fake-trigger-source does not serve the org");
  return impl;
}

const sweeper = () => k.app.get(TriggerEventSweepJob);

/** A directed event as a dispatch that passed it over left it: pending, stored `ageMs` ago. */
async function pendingDirected(ageMs: number): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("trigger_events")
    .values({
      id,
      org_id: orgId,
      plugin: PLUGIN,
      type: "item.assigned",
      subject: JSON.stringify(ITEM),
      facts: JSON.stringify({ status: "open" }),
      summary: "Assigned before.",
      dedupe_key: id,
      audience: JSON.stringify({ accountId: ownerId, agentId }),
      state: "pending",
      created_at: new Date(Date.now() - ageMs),
    })
    .execute();
  return id;
}

const dispatch = (eventId: string) =>
  withOrgScope(orgId, () => k.app.get(TriggerDispatcher).dispatch({ orgId, eventId }));

const stateOf = async (eventId: string) =>
  (
    await db
      .selectFrom("trigger_events")
      .select("state")
      .where("id", "=", eventId)
      .executeTakeFirstOrThrow()
  ).state;

const acceptanceAutomations = () =>
  db
    .selectFrom("automations")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("origin", "=", "acceptance")
    .where("deleted_at", "is", null)
    .execute();

const deliveriesOf = (automationId: string) =>
  db
    .selectFrom("automation_event_deliveries")
    .select(["event_id", "automation_run_id"])
    .where("automation_id", "=", automationId)
    .orderBy("created_at")
    .orderBy("event_id")
    .execute();

const offers = () =>
  db.selectFrom("automation_offers").selectAll().where("org_id", "=", orgId).execute();

const inboxItemsOf = (accountId: string) =>
  db
    .selectFrom("inbox_items")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .orderBy("created_at")
    .execute();

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const setRule = async (req: Req, mode: "auto" | "confirm" | "off" | null) => {
  const res = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/automations/acceptance`,
    payload: { rules: [{ source: PLUGIN, mode }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    items: { source: string; mode: string | null }[];
    directedDefault: string;
  };
};

const offerAction = (req: Req, id: string, action: "accept" | "decline") =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/automations/offers/${id}/${action}` });

describe("directed events: auto", () => {
  it("auto creates one acceptance automation and fires", async () => {
    const e = await assign();
    await dispatch(e);
    expect(await stateOf(e)).toBe("dispatched");
    const made = await acceptanceAutomations();
    expect(made).toHaveLength(1);
    const a = made[0];
    expect(a).toMatchObject({
      account_id: ownerId,
      agent_id: agentId,
      mode: "subject",
      origin: "acceptance",
      unattended_ask: "wait",
      status: "active",
      principal: { kind: "member", accountId: ownerId },
      trigger: { kind: "event", source: PLUGIN, types: ["item.assigned"], filter: [] },
      expires_at: null,
    });
    expect(a?.name).toMatch(/ · Watcher$/);
    // the prompt states the mechanism for any directed event; what happened is the event block's
    expect(a?.prompt).toBe(ACCEPTANCE_PROMPT);
    expect(ACCEPTANCE_PROMPT).not.toMatch(/assign/i);
    expect(
      await db
        .selectFrom("automation_grants")
        .select("tool_key")
        .where("automation_id", "=", a?.id as string)
        .execute(),
    ).toEqual([]);
    expect(await deliveriesOf(a?.id as string)).toEqual([{ event_id: e, automation_run_id: null }]);
    // the window's coalesce job is owed, its flush makes the run
    await withOrgScope(orgId, () =>
      k.app
        .get(EventCoalescer)
        .flush({ orgId, automationId: a?.id as string, subjectKey: subjectKey(ITEM) }),
    );
    const runs = await db
      .selectFrom("automation_runs")
      .select(["status", "trigger_key"])
      .where("automation_id", "=", a?.id as string)
      .execute();
    expect(runs).toEqual([{ status: "pending", trigger_key: e }]);
    // the person sees it in their automations
    const list = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/automations` });
    expect(
      (list.json() as { items: { id: string; origin: string }[] }).items.map((i) => [
        i.id,
        i.origin,
      ]),
    ).toEqual([[a?.id, "acceptance"]]);
  });

  it("second directed event reuses it", async () => {
    const e1 = await assign();
    await dispatch(e1);
    const e2 = await assign({ subject: OTHER });
    await dispatch(e2);
    const made = await acceptanceAutomations();
    expect(made).toHaveLength(1);
    expect((await deliveriesOf(made[0]?.id as string)).map((d) => d.event_id).sort()).toEqual(
      [e1, e2].sort(),
    );
  });

  it("concurrent first events make one acceptance automation", async () => {
    const [e1, e2] = [await assign(), await assign({ subject: OTHER })];
    await Promise.all([dispatch(e1), dispatch(e2)]);
    const made = await acceptanceAutomations();
    expect(made).toHaveLength(1);
    expect(await deliveriesOf(made[0]?.id as string)).toHaveLength(2);
  });

  it("a deleted acceptance automation is made again while the rule is auto; its trigger and agent stay fixed", async () => {
    await dispatch(await assign());
    const [a] = await acceptanceAutomations();
    const fixed = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/automations/${a?.id}`,
      payload: { trigger: { kind: "event", source: PLUGIN, types: ["item.created"] } },
    });
    expect(fixed.statusCode).toBe(400);
    expect(codeOf(fixed)).toBe("automation.acceptance_fixed");
    const edited = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/automations/${a?.id}`,
      payload: { unattendedAsk: "fail" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const del = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/automations/${a?.id}`,
    });
    expect(del.statusCode).toBe(204);
    await dispatch(await assign({ subject: OTHER }));
    const again = await acceptanceAutomations();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(a?.id);
  });

  it("a paused acceptance automation runs nothing", async () => {
    await dispatch(await assign());
    const [a] = await acceptanceAutomations();
    const paused = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/automations/${a?.id}/pause`,
    });
    expect(paused.statusCode, paused.body).toBe(200);
    const route = vi.spyOn(k.app.get(AcceptanceService), "route");
    const e = await assign({ subject: OTHER });
    await dispatch(e);
    await expect(route.mock.results[0]?.value).resolves.toBe("paused");
    expect(await stateOf(e)).toBe("dispatched");
    expect(await deliveriesOf(a?.id as string)).toHaveLength(1);
    expect(await acceptanceAutomations()).toHaveLength(1);
  });

  it("acceptance automations use up none of the person's own limits", async () => {
    const limited = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { maxTasksPerMember: 1, maxTasksPerOrg: 1 } },
    });
    expect(limited.statusCode, limited.body).toBe(200);
    await dispatch(await assign());
    expect(await acceptanceAutomations()).toHaveLength(1);
    const own = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/automations`,
      payload: {
        agentId,
        name: "Daily",
        prompt: "Summarize.",
        mode: "new",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        timeZone: "UTC",
      },
    });
    expect(own.statusCode, own.body).toBe(201);
  });

  it("acceptance runs ask the person (wait), never fail", async () => {
    const patched = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { unattendedAsk: "fail" } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const e = await assign();
    await dispatch(e);
    const [a] = await acceptanceAutomations();
    const automationId = a?.id as string;
    await withOrgScope(orgId, () =>
      k.app.get(EventCoalescer).flush({ orgId, automationId, subjectKey: subjectKey(ITEM) }),
    );
    const run = await db
      .selectFrom("automation_runs")
      .select("id")
      .where("automation_id", "=", automationId)
      .executeTakeFirstOrThrow();
    await k.app.get(AutomationFirer).fire(run.id);
    const settled = await waitFor(
      async () => {
        const r = await db
          .selectFrom("automation_runs")
          .select(["status", "run_id"])
          .where("id", "=", run.id)
          .executeTakeFirstOrThrow();
        return r.status !== "pending" && r.status !== "running" && r;
      },
      30_000,
      "acceptance run settled",
    );
    expect(settled.status).toBe("completed");
    const config = k.app.get(KernelConfigService);
    expect(await unattendedRunOf(db, config, orgId, settled.run_id as string)).toMatchObject({
      taskId: automationId,
      trial: false,
      unattendedAsk: "wait",
    });
    // the run acts as the person, with their agent
    const kernelRun = await db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.trigger_account_id", "conversations.agent_id", "conversations.subject"])
      .where("runs.id", "=", settled.run_id as string)
      .executeTakeFirstOrThrow();
    expect(kernelRun).toMatchObject({
      trigger_account_id: ownerId,
      agent_id: agentId,
      subject: { source: PLUGIN, kind: "item", id: "ITEM-1" },
    });
  });
});

describe("directed events: confirm and off", () => {
  it("confirm creates an offer, accept fires, decline notifies the causer", async () => {
    await setRule(owner, "confirm");
    const e1 = await assign();
    await dispatch(e1);
    expect(await stateOf(e1)).toBe("dispatched");
    expect(await acceptanceAutomations()).toEqual([]);
    const [offer] = await offers();
    expect(offer).toMatchObject({
      account_id: ownerId,
      event_id: e1,
      source: PLUGIN,
      agent_id: agentId,
      state: "open",
    });
    // the push-carrying kernel item, shown as the offer in the inbox
    const [item] = await inboxItemsOf(ownerId);
    expect(item).toMatchObject({
      source: "kernel",
      kind: "automation_offer",
      state: "open",
      id: offer?.inbox_item_id,
    });
    const inbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    const entries = (inbox.json() as { items: { type: string; id: string; offer?: unknown }[] })
      .items;
    expect(entries.filter((i) => i.type === "item")).toEqual([]);
    const shown = entries.find((i) => i.type === "automation_offer");
    expect(shown).toMatchObject({
      id: offer?.id,
      offer: {
        id: offer?.id,
        source: PLUGIN,
        agent: { id: agentId, name: "Watcher" },
        eventType: "item.assigned",
        subject: ITEM,
        summary: "Item ITEM-1 was assigned to you.",
        // the push names the offer's own item: the web opens the offer by it
        inboxItemId: item?.id,
      },
    });

    const accepted = await offerAction(owner, offer?.id as string, "accept");
    expect(accepted.statusCode, accepted.body).toBe(200);
    const { automationId } = accepted.json() as { automationId: string };
    const [a] = await acceptanceAutomations();
    expect(a?.id).toBe(automationId);
    expect(await deliveriesOf(automationId)).toEqual([{ event_id: e1, automation_run_id: null }]);
    expect((await offers())[0]).toMatchObject({ state: "accepted", automation_id: automationId });
    expect((await inboxItemsOf(ownerId))[0]?.state).toBe("resolved");
    const twice = await offerAction(owner, offer?.id as string, "accept");
    expect(twice.statusCode).toBe(409);
    expect(codeOf(twice)).toBe("automation.offer_closed");

    // the rule still confirms: the next event is offered too, even with the automation there
    const e2 = await assign({ subject: OTHER });
    await dispatch(e2);
    const second = (await offers()).find((o) => o.event_id === e2);
    expect(second?.state).toBe("open");
    expect(await deliveriesOf(automationId)).toHaveLength(1);
    const declined = await offerAction(owner, second?.id as string, "decline");
    expect(declined.statusCode, declined.body).toBe(204);
    expect((await offers()).find((o) => o.id === second?.id)?.state).toBe("declined");
    const told = await inboxItemsOf(memberId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      source: "kernel",
      kind: "automation_offer_declined",
      title: OTHER.title,
      state: "open",
    });
    expect(told[0]?.body).toContain("Olga");
    // who declined and for which agent stay as facts the web renders in its own copy
    expect(told[0]?.detail).toEqual({
      declinedBy: { id: ownerId, name: "Olga" },
      agent: { id: agentId, name: "Watcher" },
    });
    expect(await deliveriesOf(automationId)).toHaveLength(1);
  });

  it("a declined notice keeps an absolute subject URL as a fact (an in-app link stays the link)", async () => {
    await setRule(owner, "confirm");
    const url = "https://tracker.example.com/items/ITEM-9";
    await dispatch(await assign({ subject: { kind: "item", id: "ITEM-9", title: "Ninth", url } }));
    const [offer] = await offers();
    expect((await offerAction(owner, offer?.id as string, "decline")).statusCode).toBe(204);
    const [told] = await inboxItemsOf(memberId);
    expect(told?.link).toBeNull();
    expect(told?.detail).toMatchObject({ subjectUrl: url });
  });

  it("decline tells the owner of the run that caused the event; nobody when it is the decliner", async () => {
    await setRule(owner, "confirm");
    // caused by the owner themself (an account cause): nobody is told
    const e = await assign({ cause: { accountId: ownerId } });
    await dispatch(e);
    const [offer] = await offers();
    expect((await offerAction(owner, offer?.id as string, "decline")).statusCode).toBe(204);
    expect(await inboxItemsOf(ownerId)).toHaveLength(1); // only the offer's own item, resolved
    expect(await inboxItemsOf(memberId)).toEqual([]);
  });

  it("retention keeps an event while its offer is open", async () => {
    await setRule(owner, "confirm");
    const e = await assign();
    await dispatch(e);
    // the event is past retention, its offer is still young (open for seven days)
    await db
      .updateTable("trigger_events")
      .set({ created_at: new Date(Date.now() - 31 * 86_400_000) })
      .where("id", "=", e)
      .execute();
    expect((await sweeper().sweepAt(new Date())).expiredOffers).toBe(0);
    expect(await stateOf(e)).toBe("dispatched");
    const [offer] = await offers();
    expect((await offerAction(owner, offer?.id as string, "decline")).statusCode).toBe(204);
    await sweeper().sweepAt(new Date());
    expect(
      await db.selectFrom("trigger_events").select("id").where("id", "=", e).execute(),
    ).toEqual([]);
    expect(await offers()).toEqual([]);
  });

  it("the sweep expires an offer open past seven days, resolves its item, then retention ends it", async () => {
    await setRule(owner, "confirm");
    const e = await assign();
    await dispatch(e);
    const [offer] = await offers();
    // eight days on: the offer is stale (no longer open), the event not yet past retention
    const later = new Date(Date.now() + 8 * 86_400_000);
    const first = await sweeper().sweepAt(later);
    expect(first).toMatchObject({ expiredOffers: 1, deleted: 0 });
    expect((await offers())[0]).toMatchObject({ id: offer?.id, state: "expired" });
    expect((await inboxItemsOf(ownerId))[0]).toMatchObject({
      id: offer?.inbox_item_id,
      state: "resolved",
    });
    const inbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect((inbox.json() as { items: { type: string }[] }).items).toEqual([]);
    expect(codeOf(await offerAction(owner, offer?.id as string, "accept"))).toBe(
      "automation.offer_closed",
    );
    // past retention, the expired offer no longer keeps its event
    expect((await sweeper().sweepAt(new Date(Date.now() + 31 * 86_400_000))).deleted).toBe(1);
    expect(
      await db.selectFrom("trigger_events").select("id").where("id", "=", e).execute(),
    ).toEqual([]);
  });

  it("a source whose visible() fails while accepting leaves the offer open (offer_unavailable)", async () => {
    await setRule(owner, "confirm");
    await dispatch(await assign());
    const [offer] = await offers();
    vi.spyOn(await sourceImpl(), "visible").mockRejectedValue(new Error("the source is down"));
    const res = await offerAction(owner, offer?.id as string, "accept");
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("automation.offer_unavailable");
    expect((await offers())[0]?.state).toBe("open");
    expect(await acceptanceAutomations()).toEqual([]);
  });

  it("off fires nothing", async () => {
    await setRule(owner, "off");
    const e = await assign();
    await dispatch(e);
    expect(await stateOf(e)).toBe("dispatched");
    expect(await acceptanceAutomations()).toEqual([]);
    expect(await offers()).toEqual([]);
    expect(await inboxItemsOf(ownerId)).toEqual([]);
  });

  it("org directedDefault confirm applies when the person has no rule", async () => {
    const patched = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { directedDefault: "confirm" } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const rules = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
    });
    expect(rules.json()).toMatchObject({
      directedDefault: "confirm",
      items: [{ source: PLUGIN, mode: null }],
    });
    const e = await assign();
    await dispatch(e);
    expect(await acceptanceAutomations()).toEqual([]);
    expect((await offers()).map((o) => o.event_id)).toEqual([e]);
    // the person's own rule wins over the default
    await setRule(owner, "auto");
    await dispatch(await assign({ subject: OTHER }));
    expect(await acceptanceAutomations()).toHaveLength(1);
  });

  it("an offer past seven days is closed", async () => {
    await setRule(owner, "confirm");
    await dispatch(await assign());
    const [offer] = await offers();
    await sql`UPDATE capybara.automation_offers SET created_at = now() - interval '8 days'
      WHERE id = ${offer?.id}`.execute(raw);
    const inbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(
      (inbox.json() as { items: { type: string }[] }).items.filter(
        (i) => i.type === "automation_offer",
      ),
    ).toEqual([]);
    const res = await offerAction(owner, offer?.id as string, "accept");
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("automation.offer_closed");
    expect((await offers())[0]?.state).toBe("expired");
  });
});

describe("directed events: guards and isolation", () => {
  it("agent the person cannot use is skipped", async () => {
    const privateAgent = await newAgent(member, "Mine", "private");
    const e = await assign({ audience: { accountId: ownerId, agentId: privateAgent } });
    await dispatch(e);
    expect(await stateOf(e)).toBe("undelivered");
    expect(await acceptanceAutomations()).toEqual([]);
    expect(await offers()).toEqual([]);
  });

  it("an audience that is not a member, or is a guest, is undelivered", async () => {
    const outsider = (
      await accountsFor(db).createLocal({ login: "outsider", password: PW, displayName: "X" })
    ).id;
    const e1 = await assign({ audience: { accountId: outsider, agentId } });
    await dispatch(e1);
    expect(await stateOf(e1)).toBe("undelivered");
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", memberId)
      .execute();
    const e2 = await assign({ audience: { accountId: memberId, agentId } });
    await dispatch(e2);
    expect(await stateOf(e2)).toBe("undelivered");
    expect(await acceptanceAutomations()).toEqual([]);
    expect(await offers()).toEqual([]);
  });

  it("an org with automations switched off delivers nothing", async () => {
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { enabled: false } },
    });
    expect(off.statusCode, off.body).toBe(200);
    const e = await assign();
    await dispatch(e);
    expect(await stateOf(e)).toBe("undelivered");
    expect(await acceptanceAutomations()).toEqual([]);
  });

  it("the sweep owes a dispatch again for a directed event a dispatch passed over", async () => {
    const stale = await pendingDirected(20 * 60_000);
    const fresh = await pendingDirected(60_000);
    const owedFor = async (id: string) =>
      db
        .selectFrom("outbox")
        .select(["job_id", "data"])
        .where("job_name", "=", "trigger-dispatch")
        .where(sql<boolean>`data->>'eventId' = ${id}`)
        .execute();
    const now = new Date();
    expect((await sweeper().sweepAt(now)).redispatched).toBe(1);
    const owed = await owedFor(stale);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.job_id).toMatch(new RegExp(`^trigger-dispatch-${stale}-sweep-`));
    expect(owed[0]?.data).toEqual({ orgId, eventId: stale });
    expect(await owedFor(fresh)).toEqual([]);
    // its row still pending in the outbox: not owed twice
    expect((await sweeper().sweepAt(new Date(now.getTime() + 60_000))).redispatched).toBe(0);
    // the owed job routes it
    await dispatch(stale);
    expect(await stateOf(stale)).toBe("dispatched");
  });

  it("a source that gives no answer on who may see the subject leaves the event undelivered", async () => {
    const impl = await sourceImpl();
    vi.spyOn(impl, "visible").mockResolvedValue(undefined as never);
    const e = await assign();
    await dispatch(e);
    expect(await stateOf(e)).toBe("undelivered");
    expect(await acceptanceAutomations()).toEqual([]);
  });

  it("the sweep marks a directed event pending for over a day undelivered, once", async () => {
    const old = await pendingDirected(25 * 3_600_000);
    const fresh = await pendingDirected(20 * 60_000);
    const warn = vi.spyOn(k.app.get(TriggerEventSweepJob).log, "warn");
    const first = await sweeper().sweepAt(new Date());
    expect(await stateOf(old)).toBe("undelivered");
    expect(await stateOf(fresh)).toBe("pending");
    expect(first.redispatched).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("marked undelivered"),
      expect.objectContaining({ eventId: old }),
    );
    // settled: a second sweep neither warns again nor owes it a dispatch
    warn.mockClear();
    await sweeper().sweepAt(new Date());
    expect(warn).not.toHaveBeenCalled();
  });

  it("a subject the source does not show the person is undelivered", async () => {
    probe().visible = [memberId];
    const e = await assign();
    await dispatch(e);
    expect(await stateOf(e)).toBe("undelivered");
    expect(await acceptanceAutomations()).toEqual([]);
  });

  it("a person cannot read or change another person's rules or accept another person's offer", async () => {
    await setRule(owner, "confirm");
    const theirs = await member({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
    });
    expect(theirs.json()).toMatchObject({ items: [{ source: PLUGIN, mode: null }] });
    await setRule(member, "off");
    const mine = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
    });
    expect(mine.json()).toMatchObject({ items: [{ source: PLUGIN, mode: "confirm" }] });

    await dispatch(await assign());
    const [offer] = await offers();
    for (const action of ["accept", "decline"] as const) {
      const res = await offerAction(member, offer?.id as string, action);
      expect(res.statusCode).toBe(404);
      expect(codeOf(res)).toBe("automation.offer_not_found");
    }
    expect((await offers())[0]?.state).toBe("open");
    const inbox = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(
      (inbox.json() as { items: { type: string }[] }).items.filter(
        (i) => i.type === "automation_offer",
      ),
    ).toEqual([]);
    expect(await acceptanceAutomations()).toEqual([]);
  });

  it("a rule for a source that assigns no work is refused", async () => {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
      payload: { rules: [{ source: "nope", mode: "auto" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.event_source_unavailable");
    // removing a rule is always allowed
    const cleared = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
      payload: { rules: [{ source: "nope", mode: null }] },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
  });

  it("already-pending directed events from before are routed", async () => {
    // a directed event as the dispatcher before acceptance routing left it: pending
    const id = randomUUID();
    await db
      .insertInto("trigger_events")
      .values({
        id,
        org_id: orgId,
        plugin: PLUGIN,
        type: "item.assigned",
        subject: JSON.stringify(ITEM),
        facts: JSON.stringify({ status: "open" }),
        summary: "Assigned before.",
        dedupe_key: id,
        audience: JSON.stringify({ accountId: ownerId, agentId }),
        state: "pending",
      })
      .execute();
    await dispatch(id);
    expect(await stateOf(id)).toBe("dispatched");
    const [a] = await acceptanceAutomations();
    expect((await deliveriesOf(a?.id as string)).map((d) => d.event_id)).toEqual([id]);
  });
});
