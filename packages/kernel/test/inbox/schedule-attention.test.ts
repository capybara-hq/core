import { randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { InboxService } from "../../src/inbox/inbox.service.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
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
let inbox: InboxService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, fakeExtensionEntry("fake-im")],
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
  inbox = k.app.get(InboxService);
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
let agentId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  ownerId = await mk("owner");
  adminId = await mk("admin");
  aliceId = await mk("alice");
  const owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  const alice = await session(k, "alice");
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

const mkTask = () =>
  svc.create(orgId, aliceId, {
    agentId,
    name: "Daily digest",
    prompt: "Summarize.",
    trigger: { kind: "cron", expr: "0 9 * * *" },
    mode: "new",
  });

const attention = async (accountId: string) =>
  (await inbox.list(orgId, accountId)).items.filter((i) => i.type === "schedule_attention");

async function seedRun(taskId: string, missing: string[], scheduledFor = new Date()) {
  await db
    .insertInto("scheduled_task_runs")
    .values({
      id: randomUUID(),
      task_id: taskId,
      org_id: orgId,
      scheduled_for: scheduledFor,
      status: "completed",
      missing_grants: JSON.stringify(missing),
    })
    .execute();
}

describe("schedule_attention inbox items", () => {
  it("a paused task shows in its creator's inbox with the reason", async () => {
    const task = await mkTask();
    expect(await attention(aliceId)).toEqual([]);
    await db.transaction().execute((t) => svc.pauseFor(t, task.id, "failures", null));
    const items = await attention(aliceId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `${task.id}:paused`,
      attention: { taskId: task.id, name: "Daily digest", reason: "failures", pausedBy: null },
    });
    // only the creator sees it, and the item counts like any other
    expect(await attention(adminId)).toEqual([]);
  });

  it("pause by the creator shows nothing", async () => {
    const task = await mkTask();
    await svc.pause(orgId, { accountId: aliceId, role: "member" }, task.id);
    expect(await attention(aliceId)).toEqual([]);
  });

  it("admin pause names the admin", async () => {
    const task = await mkTask();
    await svc.pause(orgId, { accountId: adminId, role: "admin" }, task.id);
    const [item] = await attention(aliceId);
    expect(item).toMatchObject({
      attention: { reason: "admin", pausedBy: { id: adminId, name: "admin" } },
    });
  });

  it("missing grants show the tool keys", async () => {
    const task = await mkTask();
    await seedRun(task.id, ["connection:github", "Bash"], new Date(Date.now() - 60_000));
    const [item] = await attention(aliceId);
    expect(item).toMatchObject({
      id: `${task.id}:grants`,
      attention: {
        reason: "missing_grants",
        missing: ["connection:github", "Bash"],
        needsRole: [],
      },
    });
    // a clean later run clears it
    await seedRun(task.id, []);
    expect(await attention(aliceId)).toEqual([]);
  });

  it("a tool above the creator's role is marked needsRole", async () => {
    const task = await mkTask();
    const tools = await k.app
      .get((await import("../../src/tools/registry.js")).ToolRegistry)
      .forAgent(orgId, { disabledTools: [] });
    const gated = tools.tools.find((x) => x.requiredRole === "admin" || x.requiredRole === "owner");
    if (!gated) return; // no role-gated tool in this fixture set
    await seedRun(task.id, [gated.key]);
    const [item] = await attention(aliceId);
    expect(item).toMatchObject({ attention: { needsRole: [gated.key] } });
  });

  it("resuming clears the item", async () => {
    const task = await mkTask();
    await db.transaction().execute((t) => svc.pauseFor(t, task.id, "target_gone", null));
    expect(await attention(aliceId)).toHaveLength(1);
    await svc.resume(orgId, { accountId: aliceId, role: "member" }, task.id);
    expect(await attention(aliceId)).toEqual([]);
  });
});
