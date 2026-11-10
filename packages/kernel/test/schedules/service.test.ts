import { randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { nextTick } from "../../src/schedules/schedule-math.js";
import {
  type CreateTaskInput,
  grantRefusal,
  ScheduledTasksService,
} from "../../src/schedules/scheduled-tasks.service.js";
import type { ScheduleTrigger } from "../../src/schedules/types.js";
import type { ResolvedTool } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let svc: ScheduledTasksService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, fakeExtensionEntry("fake-im")],
        // fake-im loads only with its deployment config (it is never called here)
        extensionConfig: {
          "fake-im": {
            platformUrl: "http://127.0.0.1:9",
            clientId: "c1",
            clientSecret: "deploy-secret-0b4e7a",
          },
        },
      },
    ),
  );
  svc = k.app.get(ScheduledTasksService);
}, 120_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let ownerId: string;
let adminId: string;
let aliceId: string;
let bobId: string;
let guestId: string;
let alice: Req;
let agentId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  ownerId = await mk("owner");
  adminId = await mk("admin");
  aliceId = await mk("alice");
  bobId = await mk("bob");
  guestId = await mk("guest");
  const owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  alice = await session(k, "alice");
  const res = await alice({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("AskUserQuestion", "SkillWrite"),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const daily = (over: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  agentId,
  name: "Daily digest",
  prompt: "Summarize yesterday.",
  trigger: { kind: "cron", expr: "0 9 * * *" },
  mode: "new",
  ...over,
});

const me = (accountId: string, role: "guest" | "member" | "admin" | "owner" = "member") => ({
  accountId,
  role,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

const setSchedules = (patch: Record<string, unknown>) =>
  k.app.get(OrgSettingsService).update(orgId, { scheduledTasks: patch }, ownerId);

async function seedConnection(agent = agentId): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
    VALUES (${id}, ${orgId}, 'fake-im', ${`c-${id.slice(0, 6)}`}, ${agent}, ${ownerId})`.execute(
    raw,
  );
  return id;
}

async function seedThread(
  connectionId: string,
  chatId: string,
  threadKey: string,
  accountId: string,
  archived = false,
): Promise<void> {
  const conv = await createConv(alice, orgId, agentId);
  await sql`INSERT INTO capybara.channel_threads
      (id, connection_id, chat_id, thread_key, account_id, conversation_id, archived_at)
    VALUES (${randomUUID()}, ${connectionId}, ${chatId}, ${threadKey}, ${accountId}, ${conv},
      ${archived ? sql`now()` : null})`.execute(raw);
}

describe("ScheduledTasksService", () => {
  it("creates with the account zone, else the browser zone", async () => {
    const browser = await svc.create(orgId, aliceId, daily(), "Europe/Berlin");
    expect(browser.trigger.timeZone).toBe("Europe/Berlin");
    await db
      .updateTable("accounts")
      .set({ time_zone: "Asia/Shanghai" })
      .where("id", "=", aliceId)
      .execute();
    const own = await svc.create(orgId, aliceId, daily(), "Europe/Berlin");
    expect(own.trigger.timeZone).toBe("Asia/Shanghai");
    const explicit = await svc.create(orgId, aliceId, daily({ timeZone: "America/New_York" }));
    expect(explicit.trigger.timeZone).toBe("America/New_York");
    // 09:00 Shanghai is 01:00Z; the jitter is added on top
    const tick = nextTick(own.trigger, own.createdAt);
    expect(own.nextRunAt?.getTime()).toBe((tick?.getTime() ?? 0) + own.jitterSeconds * 1000);
    expect(own.status).toBe("active");
    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id"])
      .where("target", "=", own.id)
      .execute();
    expect(audit).toEqual([{ action: "schedule.created", actor_account_id: aliceId }]);
  });

  it("refuses an interval below the org minimum", async () => {
    expect(
      await codeOf(
        svc.create(orgId, aliceId, daily({ trigger: { kind: "cron", expr: "*/30 * * * *" } })),
      ),
    ).toBe("schedule.interval_too_short");
    await setSchedules({ minIntervalMinutes: 30 });
    const ok = await svc.create(
      orgId,
      aliceId,
      daily({ trigger: { kind: "cron", expr: "*/30 * * * *" } }),
    );
    expect(ok.trigger).toMatchObject({ expr: "*/30 * * * *" });
    expect(
      await codeOf(svc.create(orgId, aliceId, daily({ trigger: { kind: "cron", expr: "nope" } }))),
    ).toBe("schedule.invalid_cron");
    expect(await codeOf(svc.create(orgId, aliceId, daily({ timeZone: "Mars/Base" })))).toBe(
      "schedule.invalid_time_zone",
    );
  });

  it("lowered limit refuses new tasks only", async () => {
    await setSchedules({ maxTasksPerMember: 2 });
    const a = await svc.create(orgId, aliceId, daily());
    await svc.create(orgId, aliceId, daily());
    expect(await codeOf(svc.create(orgId, aliceId, daily()))).toBe("schedule.limit_reached");
    // bob is counted on his own
    await svc.create(orgId, bobId, daily());
    await setSchedules({ maxTasksPerMember: 1 });
    // existing tasks keep working: pause, resume, edit
    await svc.pause(orgId, me(aliceId), a.id);
    expect((await svc.resume(orgId, me(aliceId), a.id)).status).toBe("active");
    expect((await svc.update(orgId, aliceId, a.id, { name: "Renamed" })).name).toBe("Renamed");
    expect(await codeOf(svc.create(orgId, aliceId, daily()))).toBe("schedule.limit_reached");
    await setSchedules({ maxTasksPerMember: 20, maxTasksPerOrg: 3 });
    expect(await codeOf(svc.create(orgId, bobId, daily()))).toBe("schedule.limit_reached");
    await setSchedules({ enabled: false, maxTasksPerOrg: 200 });
    expect(await codeOf(svc.create(orgId, bobId, daily()))).toBe("schedule.disabled");
  });

  it("guest cannot create", async () => {
    expect(await codeOf(svc.create(orgId, guestId, daily()))).toBe("forbidden");
    expect(await codeOf(svc.create(orgId, randomUUID(), daily()))).toBe("forbidden");
  });

  it("admin lists, pauses, deletes others' tasks", async () => {
    const a = await svc.create(orgId, aliceId, daily());
    const b = await svc.create(orgId, bobId, daily());
    expect((await svc.list(orgId, me(aliceId))).map((t) => t.id)).toEqual([a.id]);
    expect(await codeOf(svc.list(orgId, me(aliceId), { all: true }))).toBe("forbidden");
    expect(
      (await svc.list(orgId, me(adminId, "admin"), { all: true })).map((t) => t.id).sort(),
    ).toEqual([a.id, b.id].sort());
    // a member cannot see another member's task
    expect(await codeOf(svc.get(orgId, me(bobId), a.id))).toBe("schedule.not_found");
    expect(await codeOf(svc.pause(orgId, me(bobId), a.id))).toBe("schedule.not_found");
    expect((await svc.get(orgId, me(adminId, "admin"), a.id)).id).toBe(a.id);

    const paused = await svc.pause(orgId, me(adminId, "admin"), a.id);
    expect(paused).toMatchObject({
      status: "paused",
      pauseReason: "admin",
      pausedBy: adminId,
      nextRunAt: null,
    });
    expect((await svc.resume(orgId, me(adminId, "admin"), a.id)).status).toBe("active");
    await svc.remove(orgId, me(adminId, "admin"), b.id);
    expect(await codeOf(svc.get(orgId, me(bobId), b.id))).toBe("schedule.not_found");
    const actions = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "target"])
      .where("org_id", "=", orgId)
      .where("action", "in", ["schedule.paused", "schedule.resumed", "schedule.deleted"])
      .orderBy("id")
      .execute();
    expect(actions).toEqual([
      { action: "schedule.paused", actor_account_id: adminId, target: a.id },
      { action: "schedule.resumed", actor_account_id: adminId, target: a.id },
      { action: "schedule.deleted", actor_account_id: adminId, target: b.id },
    ]);
    // another org's admin sees nothing
    expect(await codeOf(svc.get(randomUUID(), me(adminId, "admin"), a.id))).toBe(
      "schedule.not_found",
    );
  });

  it("admin cannot update another's task (schedule.forbidden)", async () => {
    const a = await svc.create(orgId, aliceId, daily());
    expect(await codeOf(svc.update(orgId, adminId, a.id, { prompt: "Other" }))).toBe(
      "schedule.forbidden",
    );
    expect(
      await codeOf(svc.addGrants(orgId, adminId, a.id, [{ toolKey: "AskUserQuestion" }])),
    ).toBe("schedule.forbidden");
    expect(await codeOf(svc.update(orgId, bobId, a.id, { prompt: "Other" }))).toBe(
      "schedule.not_found",
    );
    expect((await svc.update(orgId, aliceId, a.id, { prompt: "Mine" })).prompt).toBe("Mine");
  });

  it("mode and target must agree", async () => {
    const conv = await createConv(alice, orgId, agentId);
    expect(await codeOf(svc.create(orgId, aliceId, daily({ conversationId: conv })))).toBe(
      "schedule.target_invalid",
    );
    expect(await codeOf(svc.create(orgId, aliceId, daily({ mode: "conversation" })))).toBe(
      "schedule.target_invalid",
    );
    expect(await codeOf(svc.create(orgId, aliceId, daily({ mode: "chat" })))).toBe(
      "schedule.target_invalid",
    );
    // someone else's conversation is not a target
    expect(
      await codeOf(svc.create(orgId, bobId, daily({ mode: "conversation", conversationId: conv }))),
    ).toBe("schedule.target_invalid");
    const t = await svc.create(
      orgId,
      aliceId,
      daily({ mode: "conversation", conversationId: conv }),
    );
    expect(t).toMatchObject({ mode: "conversation", conversationId: conv, chat: null });
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { mode: "new" }))).toBe(
      "schedule.target_invalid",
    );
    expect(
      (await svc.update(orgId, aliceId, t.id, { mode: "new", conversationId: null })).mode,
    ).toBe("new");
  });

  it("chat target must be the creator's DM with that connection", async () => {
    const conn = await seedConnection();
    await seedThread(conn, "chat-a", "dm:ext-alice", aliceId, true);
    await seedThread(conn, "chat-b", "dm:ext-bob", bobId);
    const dm = (chatId: string, connectionId = conn) =>
      daily({ mode: "chat", chat: { connectionId, chatId, chatType: "dm" } });
    // an archived DM row is enough
    const t = await svc.create(orgId, aliceId, dm("chat-a"));
    expect(t.chat).toEqual({ connectionId: conn, chatId: "chat-a", chatType: "dm" });
    // bob's DM is not alice's
    expect(await codeOf(svc.create(orgId, aliceId, dm("chat-b")))).toBe("schedule.target_invalid");
    // a connection bound to another agent
    const other = await alice({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Other",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff(),
        },
        visibility: "org",
      },
    });
    const otherAgent = (other.json() as { agent: { id: string } }).agent.id;
    const conn2 = await seedConnection(otherAgent);
    await seedThread(conn2, "chat-a", "dm:ext-alice", aliceId);
    expect(await codeOf(svc.create(orgId, aliceId, dm("chat-a", conn2)))).toBe(
      "schedule.target_invalid",
    );
    // an inactive connection
    await db
      .updateTable("channel_connections")
      .set({ status: "disabled" })
      .where("id", "=", conn)
      .execute();
    expect(await codeOf(svc.create(orgId, aliceId, dm("chat-a")))).toBe("schedule.target_invalid");
    await db
      .updateTable("channel_connections")
      .set({ status: "active" })
      .where("id", "=", conn)
      .execute();
    // a group needs alice's thread there (fake-im has threads)
    const group = (chatId: string) =>
      daily({ mode: "chat", chat: { connectionId: conn, chatId, chatType: "group" } });
    expect(await codeOf(svc.create(orgId, aliceId, group("grp")))).toBe("schedule.target_invalid");
    await seedThread(conn, "grp", "om_root_1", aliceId);
    expect((await svc.create(orgId, aliceId, group("grp"))).chat?.chatType).toBe("group");
    // a DM chat type does not accept a group's thread row
    expect(await codeOf(svc.create(orgId, aliceId, dm("grp")))).toBe("schedule.target_invalid");
  });

  it("refuses a forbidden or role-escalated tool as a grant", async () => {
    const t = await svc.create(orgId, aliceId, daily({ grants: [{ toolKey: "AskUserQuestion" }] }));
    const grants = await svc.grants(orgId, me(aliceId), t.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ toolKey: "AskUserQuestion", connectorId: null });
    expect(grants[0]?.specHash).toMatch(/^[0-9a-f]{16}$/);
    // SkillWrite never; a tool the agent does not have; a connector that is not the tool's
    for (const g of [
      { toolKey: "SkillWrite" },
      { toolKey: "Bash" },
      { toolKey: "AskUserQuestion", connectorId: randomUUID() },
    ]) {
      expect(await codeOf(svc.addGrants(orgId, aliceId, t.id, [g]))).toBe(
        "schedule.grant_not_allowed",
      );
    }
    await setSchedules({ forbiddenTools: ["AskUserQuestion"] });
    expect(
      await codeOf(svc.create(orgId, aliceId, daily({ grants: [{ toolKey: "AskUserQuestion" }] }))),
    ).toBe("schedule.grant_not_allowed");
    // the refused create left nothing behind
    expect(await svc.list(orgId, me(aliceId))).toHaveLength(1);
    await svc.removeGrant(orgId, aliceId, t.id, "AskUserQuestion");
    expect(await svc.grants(orgId, me(aliceId), t.id)).toEqual([]);

    // role escalation and fixed asks (no live tool declares requiredRole yet: checked directly)
    const tool = (over: Partial<ResolvedTool> = {}): ResolvedTool => ({
      key: "Deploy",
      source: { kind: "plugin", plugin: "ops", name: "deploy" },
      spec: { name: "deploy", description: "d", inputSchema: { type: "object" } },
      specHash: "0123456789abcdef",
      defaultPolicy: "ask",
      ...over,
    });
    const ctx = { role: "member" as const, visibility: "org" as const, forbiddenTools: [] };
    expect(grantRefusal("Deploy", tool(), ctx)).toBeNull();
    expect(grantRefusal("Deploy", tool({ requiredRole: "admin" }), ctx)).toMatch(/admin role/);
    expect(
      grantRefusal("Deploy", tool({ requiredRole: "admin" }), { ...ctx, role: "admin" }),
    ).toBeNull();
    expect(
      grantRefusal(
        "Deploy",
        tool({
          spec: {
            name: "deploy",
            description: "d",
            inputSchema: {},
            annotations: { requiresUserInteraction: true },
          },
        }),
        ctx,
      ),
    ).toMatch(/always asks/);
  });

  it("once in the past is refused", async () => {
    const once = (at: string) => daily({ trigger: { kind: "once", at }, timeZone: "UTC" });
    expect(await codeOf(svc.create(orgId, aliceId, once("2020-01-01T09:00")))).toBe(
      "schedule.once_in_past",
    );
    expect(await codeOf(svc.create(orgId, aliceId, once("2030-02-30T09:00")))).toBe(
      "schedule.invalid_once_time",
    );
    const t = await svc.create(orgId, aliceId, once("2030-01-01T09:00"));
    expect(t).toMatchObject({ jitterSeconds: 0, expiresAt: null });
    expect(t.nextRunAt?.toISOString()).toBe("2030-01-01T09:00:00.000Z");
  });

  it("expires_at: the creator's value wins, else the org default for a cron task", async () => {
    const until = new Date(Date.now() + 3 * 86_400_000);
    expect((await svc.create(orgId, aliceId, daily({ expiresAt: until }))).expiresAt).toEqual(
      until,
    );
    expect((await svc.create(orgId, aliceId, daily())).expiresAt).toBeNull();
    expect(
      await codeOf(svc.create(orgId, aliceId, daily({ expiresAt: new Date(Date.now() - 1000) }))),
    ).toBe("validation_failed");
    await setSchedules({ defaultExpiryDays: 7 });
    // an explicit expiry beats the org default
    expect((await svc.create(orgId, aliceId, daily({ expiresAt: until }))).expiresAt).toEqual(
      until,
    );
    // absent or null: the org default
    for (const over of [{}, { expiresAt: null }]) {
      const before = Date.now();
      const t = await svc.create(orgId, aliceId, daily(over));
      const ms = (t.expiresAt?.getTime() ?? 0) - before;
      expect(ms).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
      expect(ms).toBeLessThan(7 * 86_400_000 + 60_000);
    }
    // the default applies to recurring tasks only
    const once = await svc.create(
      orgId,
      aliceId,
      daily({ trigger: { kind: "once", at: "2030-01-01T09:00" } }),
    );
    expect(once.expiresAt).toBeNull();
  });

  it("caps the name and prompt lengths", async () => {
    expect(await codeOf(svc.create(orgId, aliceId, daily({ name: "n".repeat(201) })))).toBe(
      "validation_failed",
    );
    expect(await codeOf(svc.create(orgId, aliceId, daily({ prompt: "p".repeat(20_001) })))).toBe(
      "validation_failed",
    );
    const t = await svc.create(
      orgId,
      aliceId,
      daily({ name: "n".repeat(200), prompt: "p".repeat(20_000) }),
    );
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { name: "  " }))).toBe(
      "validation_failed",
    );
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { prompt: "p".repeat(20_001) }))).toBe(
      "validation_failed",
    );
  });

  it("changing the agent re-checks the task's grants", async () => {
    const t = await svc.create(orgId, aliceId, daily({ grants: [{ toolKey: "AskUserQuestion" }] }));
    const mkAgent = async (keep: string[]) => {
      const res = await alice({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Other",
            instructions: "x",
            model: { provider: "model-fake", model: "fake-1" },
            disabledTools: builtinsOff(...keep),
          },
          visibility: "org",
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { agent: { id: string } }).agent.id;
    };
    // the new agent lacks the granted tool: refused, nothing changes
    const bare = await mkAgent([]);
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { agentId: bare }))).toBe(
      "schedule.grant_not_allowed",
    );
    expect((await svc.get(orgId, me(aliceId), t.id)).agentId).toBe(agentId);
    // the new agent has it: the grant carries over
    const asks = await mkAgent(["AskUserQuestion"]);
    expect((await svc.update(orgId, aliceId, t.id, { agentId: asks })).agentId).toBe(asks);
    expect((await svc.grants(orgId, me(aliceId), t.id)).map((g) => g.toolKey)).toEqual([
      "AskUserQuestion",
    ]);
  });

  it("resume recomputes next_run_at from now", async () => {
    const trigger = { kind: "cron", expr: "0 * * * *" } as const;
    const t = await svc.create(orgId, aliceId, daily({ trigger, timeZone: "UTC" }));
    const paused = await svc.pause(orgId, me(aliceId), t.id);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "creator", pausedBy: aliceId });
    // a stale next run and failures from before the pause do not survive the resume
    await db
      .updateTable("scheduled_tasks")
      .set({ next_run_at: new Date("2020-01-01T00:00:00Z"), consecutive_failures: 4 })
      .where("id", "=", t.id)
      .execute();
    const from = new Date();
    const resumed = await svc.resume(orgId, me(aliceId), t.id);
    const to = new Date();
    const full: ScheduleTrigger = { ...trigger, timeZone: "UTC" };
    const expected = [from, to].map(
      (d) => (nextTick(full, d)?.getTime() ?? 0) + t.jitterSeconds * 1000,
    );
    expect(expected).toContain(resumed.nextRunAt?.getTime());
    expect(resumed).toMatchObject({
      status: "active",
      pauseReason: null,
      pausedBy: null,
      consecutiveFailures: 0,
    });
    // a guest (demoted creator) may pause but not resume
    await svc.pause(orgId, me(aliceId), t.id);
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", aliceId)
      .execute();
    expect(await codeOf(svc.resume(orgId, me(aliceId), t.id))).toBe("forbidden");
  });

  it("pauseFor pauses an active task once, with the reason", async () => {
    const t = await svc.create(orgId, aliceId, daily());
    await svc.pauseFor(db, t.id, "agent_gone", null);
    await svc.pauseFor(db, t.id, "failures", null);
    expect(await svc.get(orgId, me(aliceId), t.id)).toMatchObject({
      status: "paused",
      pauseReason: "agent_gone",
      pausedBy: null,
      nextRunAt: null,
    });
  });
});
