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
  grantRefusalOf,
  ScheduledTasksService,
} from "../../src/schedules/scheduled-tasks.service.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
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
  enableExtensions,
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
        disabledTools: builtinsOff("AskUserQuestion"),
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

/** The actor (the service reads the role itself; the name says who it is in the test). */
const me = (accountId: string, _role?: "guest" | "member" | "admin" | "owner") => ({ accountId });

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
  // a connection exists only on an extension the org has enabled (a chat target asks for it)
  await enableExtensions(raw, orgId, "fake-im");
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
    // a skill change never; a tool the agent does not have; a connector that is not the tool's
    for (const g of [
      { toolKey: "Platform:agents.register-skill" },
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
    const ctx = { role: "member" as const, forbiddenTools: [] };
    expect(grantRefusal("Deploy", tool(), ctx)).toBeNull();
    // the codes the web words (grantable-tools)
    expect(grantRefusalOf("Deploy", tool({ requiredRole: "admin" }), ctx)?.code).toBe("needs_role");
    expect(grantRefusalOf("Deploy", tool(), { ...ctx, forbiddenTools: ["Deploy"] })?.code).toBe(
      "forbidden",
    );
    // an unattended run never changes the agent's skills, whatever tool the key resolves to
    expect(grantRefusalOf("Platform:agents.register-skill", tool(), ctx)?.code).toBe(
      "not_grantable",
    );
    expect(grantRefusalOf("Deploy", undefined, ctx)?.code).toBe("not_available");
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

  it("model, effort and device are for new-conversation tasks only, and must resolve", async () => {
    const conv = await createConv(alice, orgId, agentId);
    const fake1 = { provider: "model-fake", model: "fake-1" };
    const inConv = daily({ mode: "conversation", conversationId: conv });
    // a conversation or chat task runs with that conversation's selection and device
    for (const over of [{ model: fake1 }, { effort: "high" }, { deviceId: randomUUID() }]) {
      expect(await codeOf(svc.create(orgId, aliceId, { ...inConv, ...over }))).toBe(
        "validation_failed",
      );
    }
    // a new-conversation task: the model must resolve and offer the effort
    expect(
      await codeOf(
        svc.create(orgId, aliceId, daily({ model: { provider: "model-fake", model: "nope" } })),
      ),
    ).toBe("agent.model_unavailable");
    expect(await codeOf(svc.create(orgId, aliceId, daily({ effort: "xhigh" })))).toBe(
      "validation_failed",
    );
    const t = await svc.create(orgId, aliceId, daily({ model: fake1, effort: "high" }));
    expect(t).toMatchObject({ model: fake1, effort: "high" });
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { effort: "xhigh" }))).toBe(
      "validation_failed",
    );
    // switching to a conversation clears them; setting them there is refused
    const moved = await svc.update(orgId, aliceId, t.id, {
      mode: "conversation",
      conversationId: conv,
    });
    expect(moved).toMatchObject({ mode: "conversation", model: null, effort: null });
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { model: fake1 }))).toBe(
      "validation_failed",
    );
    expect(await codeOf(svc.update(orgId, aliceId, t.id, { effort: "low" }))).toBe(
      "validation_failed",
    );
    // clearing is always fine
    expect(
      (await svc.update(orgId, aliceId, t.id, { model: null, effort: null })).model,
    ).toBeNull();
  });

  it("update with a null expiry falls back to the org default for a cron task", async () => {
    const t = await svc.create(orgId, aliceId, daily());
    expect(t.expiresAt).toBeNull();
    await setSchedules({ defaultExpiryDays: 7 });
    const before = Date.now();
    const u = await svc.update(orgId, aliceId, t.id, { expiresAt: null });
    const ms = (u.expiresAt?.getTime() ?? 0) - before;
    expect(ms).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(ms).toBeLessThan(7 * 86_400_000 + 60_000);
    // a one-off task has no default expiry
    const once = await svc.create(
      orgId,
      aliceId,
      daily({ trigger: { kind: "once", at: "2030-01-01T09:00" } }),
    );
    expect((await svc.update(orgId, aliceId, once.id, { expiresAt: null })).expiresAt).toBeNull();
  });

  it("a creator demoted to guest still lists, pauses and deletes their own tasks", async () => {
    const t = await svc.create(orgId, aliceId, daily());
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", aliceId)
      .execute();
    expect((await svc.list(orgId, me(aliceId))).map((x) => x.id)).toEqual([t.id]);
    expect((await svc.pause(orgId, me(aliceId), t.id)).status).toBe("paused");
    await svc.remove(orgId, me(aliceId), t.id);
    expect(await svc.list(orgId, me(aliceId))).toEqual([]);
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

describe("ScheduledTasksService.calendar", () => {
  const DAY = 86_400_000;
  /** A week around now in UTC (whole days). */
  const week = (over: Partial<{ all: boolean; taskId: string; from: Date; to: Date }> = {}) => {
    const today = Math.floor(Date.now() / DAY) * DAY;
    return {
      from: new Date(today - 2 * DAY),
      to: new Date(today + 5 * DAY),
      timeZone: "UTC",
      ...over,
    };
  };
  /** A finished run of the task two days ago at 09:00 UTC, with the details only its creator sees. */
  const pastRun = async (taskId: string) => {
    const at = new Date(Math.floor(Date.now() / DAY) * DAY - 2 * DAY + 9 * 3_600_000);
    const store = k.app.get(ScheduledTaskStore);
    const run = await store.insertRun(db, {
      id: randomUUID(),
      taskId,
      orgId,
      scheduledFor: at,
      trial: false,
      status: "failed",
      firedAt: at,
      conversationId: null,
    });
    await store.updateRun(db, run?.id ?? "", {
      error: "The model failed",
      missingGrants: ["Bash"],
    });
    return run?.id;
  };

  it("a member reads their own tasks only; all is for org admins", async () => {
    const mine = await svc.create(orgId, aliceId, daily());
    const theirs = await svc.create(orgId, bobId, daily({ name: "Bob's" }));
    const runId = await pastRun(mine.id);
    await pastRun(theirs.id);
    const a = await svc.calendar(orgId, me(aliceId), week());
    expect(a.tasks.map((t) => t.id)).toEqual([mine.id]);
    expect(new Set(a.items.map((i) => i.taskId))).toEqual(new Set([mine.id]));
    expect(a.items.find((i) => i.kind === "run")).toMatchObject({
      id: runId,
      status: "failed",
      error: "The model failed",
      missingGrants: 1,
    });
    expect(await codeOf(svc.calendar(orgId, me(aliceId), week({ all: true })))).toBe("forbidden");
  });

  it("an admin's all sees every task, without another member's conversation, error or grants", async () => {
    const mine = await svc.create(orgId, adminId, daily({ name: "Admin's" }));
    const theirs = await svc.create(orgId, aliceId, daily());
    await pastRun(mine.id);
    await pastRun(theirs.id);
    const a = await svc.calendar(orgId, me(adminId, "admin"), week({ all: true }));
    expect(a.tasks.map((t) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
    const runs = a.items.filter((i) => i.kind === "run");
    expect(runs.find((r) => r.taskId === theirs.id)).toMatchObject({
      status: "failed",
      conversationId: null,
      error: null,
      missingGrants: null,
    });
    expect(runs.find((r) => r.taskId === mine.id)).toMatchObject({
      error: "The model failed",
      missingGrants: 1,
    });
    // without all an admin reads their own; with taskId any task of the org
    expect((await svc.calendar(orgId, me(adminId), week())).tasks.map((t) => t.id)).toEqual([
      mine.id,
    ]);
    const one = await svc.calendar(orgId, me(adminId), {
      ...week({ taskId: theirs.id }),
      to: new Date(week().from.getTime() + 2 * DAY),
    });
    expect(one.items.find((i) => i.kind === "run")).toMatchObject({ error: null });
  });

  it("taskId must be a task the caller may see", async () => {
    const theirs = await svc.create(orgId, bobId, daily());
    const range = { ...week({ taskId: theirs.id }), to: new Date(week().from.getTime() + DAY) };
    expect(await codeOf(svc.calendar(orgId, me(aliceId), range))).toBe("schedule.not_found");
    expect(await codeOf(svc.calendar(orgId, me(aliceId), { ...range, taskId: randomUUID() }))).toBe(
      "schedule.not_found",
    );
    expect((await svc.calendar(orgId, me(bobId), range)).collapsed).toEqual([]);
  });

  it("a creator demoted to guest still reads their own", async () => {
    const t = await svc.create(orgId, aliceId, daily());
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", aliceId)
      .execute();
    expect((await svc.calendar(orgId, me(aliceId), week())).tasks.map((x) => x.id)).toEqual([t.id]);
    expect(await codeOf(svc.calendar(orgId, me(guestId), week({ all: true })))).toBe("forbidden");
  });

  it("the first occurrence is next_run_at - jitter, and its at is next_run_at", async () => {
    const t = await svc.create(orgId, aliceId, daily());
    const a = await svc.calendar(orgId, me(aliceId), week());
    const first = a.items.find((i) => i.kind === "occurrence");
    const next = t.nextRunAt?.getTime() ?? 0;
    expect(first).toEqual({
      kind: "occurrence",
      taskId: t.id,
      scheduledFor: new Date(next - t.jitterSeconds * 1000).toISOString(),
      at: new Date(next).toISOString(),
    });
  });

  it("deleted tasks are hidden; paused tasks and an org turned off have runs but no occurrences", async () => {
    const gone = await svc.create(orgId, aliceId, daily({ name: "Gone" }));
    await pastRun(gone.id);
    await svc.remove(orgId, me(aliceId), gone.id);
    const paused = await svc.create(orgId, aliceId, daily({ name: "Paused" }));
    await pastRun(paused.id);
    await svc.pause(orgId, me(aliceId), paused.id);
    const live = await svc.create(orgId, aliceId, daily({ name: "Live" }));
    const a = await svc.calendar(orgId, me(aliceId), week());
    expect(a.tasks.map((t) => t.id).sort()).toEqual([paused.id, live.id].sort());
    expect(a.items.filter((i) => i.taskId === paused.id).map((i) => i.kind)).toEqual(["run"]);
    expect(a.items.some((i) => i.taskId === live.id && i.kind === "occurrence")).toBe(true);
    await setSchedules({ enabled: false });
    const off = await svc.calendar(orgId, me(aliceId), week());
    expect(off.items.map((i) => i.kind)).toEqual(["run"]);
  });

  it("refuses a range that is not forward or too long", async () => {
    const from = new Date("2026-11-09T00:00:00Z");
    const q = (to: Date, taskId?: string) => ({
      from,
      to,
      timeZone: "UTC",
      ...(taskId !== undefined && { taskId }),
    });
    expect(await codeOf(svc.calendar(orgId, me(aliceId), q(from)))).toBe("validation_failed");
    expect(await codeOf(svc.calendar(orgId, me(aliceId), q(new Date(from.getTime() - DAY))))).toBe(
      "validation_failed",
    );
    expect(
      await codeOf(svc.calendar(orgId, me(aliceId), q(new Date(from.getTime() + 43 * DAY + 1)))),
    ).toBe("validation_failed");
    await svc.calendar(orgId, me(aliceId), q(new Date(from.getTime() + 43 * DAY)));
    const t = await svc.create(orgId, aliceId, daily());
    expect(
      await codeOf(
        svc.calendar(orgId, me(aliceId), q(new Date(from.getTime() + 2 * DAY + 1), t.id)),
      ),
    ).toBe("validation_failed");
  });
});
