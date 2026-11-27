import type { TestContainer } from "@capybara-hq/testing";
import { fakeExtensionEntry, startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Creating and editing event automations through the HTTP API (collaboration spec §4.1, §4.3):
 * the event-sources route, the source / type / filter checks, the mode rules (`subject` needs an
 * event trigger, `chat` a time one; on create and on PATCH) and `unattendedAsk`.
 */

const PLUGIN = "fake-trigger-source";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
    ),
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let owner: Req;
let alice: Req;
let guest: Req;
let agentId: string;

const base = () => `/api/v1/orgs/${orgId}/automations`;
const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  const aliceId = await mk("alice");
  const guestId = await mk("guest");
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  alice = await session(k, "alice");
  guest = await session(k, "guest");
  await enableExtensions(raw, orgId, PLUGIN);
  const res = await alice({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("AskUserQuestion"),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const event = (over: Record<string, unknown> = {}) => ({
  kind: "event",
  source: PLUGIN,
  types: ["item.created", "item.updated"],
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  agentId,
  name: "Follow items",
  prompt: "Look at the item.",
  trigger: event(),
  mode: "new",
  ...over,
});

type Task = {
  id: string;
  mode: string;
  status: string;
  nextRunAt: string | null;
  unattendedAsk: string | null;
  trigger: {
    kind: string;
    source?: string;
    types?: string[];
    filter?: unknown[];
    timeZone?: string;
  };
};

const create = (over: Record<string, unknown> = {}, req: Req = alice) =>
  req({ method: "POST", url: base(), payload: body(over) });

async function createOk(over: Record<string, unknown> = {}): Promise<Task> {
  const res = await create(over);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { task: Task }).task;
}

describe("GET event-sources", () => {
  it("lists the declarations of the sources that serve the org", async () => {
    const res = await alice({ method: "GET", url: `${base()}/event-sources` });
    expect(res.statusCode, res.body).toBe(200);
    const { items } = res.json() as {
      items: {
        source: string;
        name: { zh: string; en: string };
        events: {
          type: string;
          directed: boolean;
          facts: Record<string, { filterable: boolean }>;
        }[];
      }[];
    };
    expect(items.map((i) => i.source)).toEqual([PLUGIN]);
    expect(items[0]?.name).toEqual({ zh: PLUGIN, en: PLUGIN });
    expect(items[0]?.events.map((e) => [e.type, e.directed])).toEqual([
      ["item.created", false],
      ["item.updated", false],
      ["item.assigned", true],
    ]);
    const facts = items[0]?.events[0]?.facts ?? {};
    expect(Object.keys(facts).sort()).toEqual([
      "internalNote",
      "labels",
      "priority",
      "projectKey",
      "status",
    ]);
    expect(facts.internalNote?.filterable).toBe(false);
  });

  it("leaves out a source the org has not enabled and one it switched off", async () => {
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE org_id = ${orgId} AND plugin = ${PLUGIN}`.execute(raw);
    let res = await alice({ method: "GET", url: `${base()}/event-sources` });
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
    await enableExtensions(raw, orgId, PLUGIN);
    res = await alice({ method: "GET", url: `${base()}/event-sources` });
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { eventSourcesOff: [PLUGIN] } },
    });
    expect(off.statusCode, off.body).toBe(200);
    res = await alice({ method: "GET", url: `${base()}/event-sources` });
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("is for members: a guest gets 403", async () => {
    const res = await guest({ method: "GET", url: `${base()}/event-sources` });
    expect(res.statusCode).toBe(403);
  });
});

describe("create an event automation", () => {
  it("stores the event trigger with no tick, no zone and the chosen unattendedAsk", async () => {
    const t = await createOk({
      trigger: event({
        types: ["item.created", "item.created", "item.updated"],
        filter: [
          { fact: "status", op: "eq", value: "open" },
          { fact: "projectKey", op: "in", value: ["CORE", "WEB"] },
          { fact: "labels", op: "contains", value: "bug" },
          { fact: "priority", op: "eq", value: 2 },
        ],
      }),
      unattendedAsk: "wait",
    });
    expect(t).toMatchObject({
      mode: "new",
      status: "active",
      nextRunAt: null,
      unattendedAsk: "wait",
      trigger: { kind: "event", source: PLUGIN, types: ["item.created", "item.updated"] },
    });
    expect(t.trigger.timeZone).toBeUndefined();
    expect(t.trigger.filter).toHaveLength(4);
    const row = await db
      .selectFrom("automations")
      .select(["next_run_at", "unattended_ask"])
      .where("id", "=", t.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ next_run_at: null, unattended_ask: "wait" });
  });

  it("a missing filter is an empty one and unattendedAsk defaults to the org's (null)", async () => {
    const t = await createOk();
    expect(t.trigger.filter).toEqual([]);
    expect(t.unattendedAsk).toBeNull();
  });

  it("an unknown type is 400 automation.event_type_unknown", async () => {
    const res = await create({ trigger: event({ types: ["item.created", "item.vanished"] }) });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.event_type_unknown");
  });

  it("a directed type cannot trigger an automation", async () => {
    const res = await create({ trigger: event({ types: ["item.assigned"] }) });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.event_type_unknown");
  });

  it("a source that is not a trigger source of the org is 400 automation.event_source_unavailable", async () => {
    let res = await create({ trigger: event({ source: "no-such-source" }) });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.event_source_unavailable");
    // a source the org switched off
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { automations: { eventSourcesOff: [PLUGIN] } },
    });
    expect(off.statusCode, off.body).toBe(200);
    res = await create();
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.event_source_unavailable");
  });

  it.each([
    ["a fact the type does not declare", { fact: "nope", op: "eq", value: "x" }],
    ["a fact that is not filterable", { fact: "internalNote", op: "eq", value: "x" }],
    ["eq with a value of the wrong type", { fact: "priority", op: "eq", value: "high" }],
    ["eq on a list fact", { fact: "labels", op: "eq", value: "bug" }],
    ["in on a number fact", { fact: "priority", op: "in", value: ["1"] }],
    ["contains on a string fact", { fact: "status", op: "contains", value: "o" }],
  ])("a filter on %s is 400 automation.filter_invalid", async (_name, clause) => {
    const res = await create({ trigger: event({ filter: [clause] }) });
    expect(res.statusCode, res.body).toBe(400);
    expect(codeOf(res)).toBe("automation.filter_invalid");
  });

  it("subject mode with an event trigger needs no conversation or chat", async () => {
    const t = await createOk({ mode: "subject" });
    expect(t.mode).toBe("subject");
    const res = await create({ mode: "subject", conversationId: "c1" });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
  });

  it("subject mode with a cron trigger is 400, and chat mode with an event trigger too", async () => {
    let res = await create({ mode: "subject", trigger: { kind: "cron", expr: "0 9 * * *" } });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/event trigger/);
    res = await create({
      mode: "chat",
      chat: { connectionId: "cn1", chatId: "c", chatType: "dm" },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/chat/);
  });

  it("an event trigger takes no unknown keys", async () => {
    const res = await create({ trigger: event({ expr: "0 9 * * *" }) });
    expect(res.statusCode).toBe(400);
  });
});

describe("model, effort and device by mode", () => {
  const pick = { model: { provider: "model-fake", model: "fake-1" } };

  it("a subject automation keeps a model and effort; a device is refused", async () => {
    const t = await createOk({ mode: "subject", ...pick });
    expect(t).toMatchObject({ mode: "subject", model: pick.model });
    const dev = await create({ mode: "subject", deviceId: "d1" });
    expect(dev.statusCode).toBe(400);
    expect(codeOf(dev)).toBe("validation_failed");
    const badEffort = await create({ mode: "subject", ...pick, effort: "nope" });
    expect(badEffort.statusCode).toBe(400);
  });

  it("PATCH keeps and changes a subject automation's model; a device is refused", async () => {
    const t = await createOk({ mode: "subject", ...pick });
    let res = await alice({
      method: "PATCH",
      url: `${base()}/${t.id}`,
      payload: { name: "Renamed" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: { model: unknown } }).task.model).toEqual(pick.model);
    res = await alice({ method: "PATCH", url: `${base()}/${t.id}`, payload: { model: null } });
    expect((res.json() as { task: { model: unknown } }).task.model).toBeNull();
    res = await alice({ method: "PATCH", url: `${base()}/${t.id}`, payload: { deviceId: "d1" } });
    expect(res.statusCode).toBe(400);
  });

  it("a conversation automation still takes none", async () => {
    const res = await create({ mode: "conversation", conversationId: "c1", ...pick });
    expect(res.statusCode).toBe(400);
  });
});

describe("update an event automation", () => {
  const patch = (id: string, payload: Record<string, unknown>) =>
    alice({ method: "PATCH", url: `${base()}/${id}`, payload });

  it("edits the trigger, keeps next_run_at null and sets unattendedAsk", async () => {
    const t = await createOk();
    const res = await patch(t.id, {
      trigger: event({
        types: ["item.updated"],
        filter: [{ fact: "status", op: "eq", value: "x" }],
      }),
      unattendedAsk: "fail",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task).toMatchObject({
      nextRunAt: null,
      unattendedAsk: "fail",
      trigger: { kind: "event", types: ["item.updated"] },
    });
    const cleared = await patch(t.id, { unattendedAsk: null });
    expect((cleared.json() as { task: Task }).task.unattendedAsk).toBeNull();
  });

  it("a bad event trigger on PATCH is refused with the same codes", async () => {
    const t = await createOk();
    let res = await patch(t.id, { trigger: event({ types: ["item.vanished"] }) });
    expect(codeOf(res)).toBe("automation.event_type_unknown");
    res = await patch(t.id, {
      trigger: event({ filter: [{ fact: "internalNote", op: "eq", value: "x" }] }),
    });
    expect(codeOf(res)).toBe("automation.filter_invalid");
    res = await patch(t.id, { trigger: event({ source: "other" }) });
    expect(codeOf(res)).toBe("automation.event_source_unavailable");
  });

  it("a cron automation becomes an event one: its next run is cleared", async () => {
    const cron = await createOk({ trigger: { kind: "cron", expr: "0 9 * * *" }, timeZone: "UTC" });
    expect(cron.nextRunAt).not.toBeNull();
    const res = await patch(cron.id, { trigger: event() });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task).toMatchObject({
      nextRunAt: null,
      trigger: { kind: "event" },
    });
  });

  it("a subject automation cannot switch to a time trigger while the mode stays subject", async () => {
    const t = await createOk({ mode: "subject" });
    const res = await patch(t.id, {
      trigger: { kind: "cron", expr: "0 9 * * *" },
      timeZone: "UTC",
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
    const row = await db
      .selectFrom("automations")
      .select("trigger")
      .where("id", "=", t.id)
      .executeTakeFirstOrThrow();
    expect(row.trigger.kind).toBe("event");
    // together with a mode a time trigger can have, it goes through
    const ok = await patch(t.id, {
      trigger: { kind: "cron", expr: "0 9 * * *" },
      timeZone: "UTC",
      mode: "new",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { task: Task }).task.nextRunAt).not.toBeNull();
  });

  it("subject mode on a time automation and chat mode on an event one are refused", async () => {
    const cron = await createOk({ trigger: { kind: "cron", expr: "0 9 * * *" }, timeZone: "UTC" });
    let res = await patch(cron.id, { mode: "subject" });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
    const ev = await createOk();
    res = await patch(ev.id, {
      mode: "chat",
      chat: { connectionId: "cn1", chatId: "c", chatType: "dm" },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe("automation.target_invalid");
    res = await patch(ev.id, { mode: "subject" });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("an event automation that is paused resumes with no next run", async () => {
    const t = await createOk();
    let res = await alice({ method: "POST", url: `${base()}/${t.id}/pause` });
    expect(res.statusCode, res.body).toBe(200);
    res = await alice({ method: "POST", url: `${base()}/${t.id}/resume` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task).toMatchObject({
      status: "active",
      nextRunAt: null,
    });
  });
});
