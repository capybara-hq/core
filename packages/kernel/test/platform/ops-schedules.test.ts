import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
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

/** The schedules.* Platform operations run through their own `run` and `summary`. */

const MODEL = { provider: "model-fake", model: "fake-1" };
const DIGEST = { kind: "cron", expr: "0 9 * * *" };

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let ops: PlatformOperations;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE] }));
  ops = k.app.get(PlatformOperations);
});
afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let aliceId: string;
let bobId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(db, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  aliceId = await mk("alice");
  bobId = await mk("bob");
  orgId = await createOrg(await session(k, "owner"));
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  const r = await k.app.get(AgentsService).create(orgId, aliceId, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: MODEL,
      disabledSkills: [],
      disabledTools: builtinsOff("AskUserQuestion"),
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
    },
    visibility: "org",
  });
  agentId = r.agent.id;
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};
const ctxOf = (accountId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "member"));
  });
};
const summary = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.summary?.(o.input.parse(input), ctx);
};

async function createTask(accountId = aliceId) {
  const out = (await run(
    "schedules.create",
    {
      agentId,
      name: "Daily digest",
      prompt: "Summarize yesterday.",
      trigger: DIGEST,
      mode: "new",
      timeZone: "Asia/Shanghai",
      model: MODEL,
    },
    ctxOf(accountId),
  )) as { task: { id: string; model: unknown; trigger: { timeZone: string } } };
  return out.task;
}

describe("schedules operations", () => {
  it("create, list, get: output mapping and the model object", async () => {
    const t = await createTask();
    expect(t.model).toEqual(MODEL);
    expect(t.trigger.timeZone).toBe("Asia/Shanghai");
    const list = (await run("schedules.list", {}, ctxOf(aliceId))) as { items: object[] };
    expect(list.items).toEqual([
      expect.objectContaining({
        id: t.id,
        name: "Daily digest",
        status: "active",
        creator: aliceId,
      }),
    ]);
    expect(list.items[0]).not.toHaveProperty("prompt");
    const got = (await run("schedules.get", { scheduleId: t.id }, ctxOf(aliceId))) as {
      task: { prompt: string };
    };
    expect(got.task.prompt).toBe("Summarize yesterday.");
    const card = await summary(
      "schedules.create",
      { agentId, name: "N", prompt: "p", trigger: DIGEST, mode: "new" },
      ctxOf(aliceId),
    );
    expect(card?.en).toContain('"N"');
  });

  it("update takes scheduleId and names the task in its card", async () => {
    const t = await createTask();
    const ctx = ctxOf(aliceId);
    const out = (await run(
      "schedules.update",
      { scheduleId: t.id, name: "Digest 2", model: null },
      ctx,
    )) as { task: { name: string; model: unknown } };
    expect(out.task).toMatchObject({ name: "Digest 2", model: null });
    expect(await summary("schedules.update", { scheduleId: t.id, name: "x" }, ctx)).toEqual({
      zh: "修改定时任务「Digest 2」",
      en: 'Change scheduled task "Digest 2"',
    });
    await expect(
      run("schedules.update", { scheduleId: t.id, name: "y" }, ctxOf(bobId)),
    ).rejects.toThrow();
  });

  it("a guest pauses and deletes their own task but not another's", async () => {
    const t = await createTask(aliceId);
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("account_id", "=", aliceId)
      .execute();
    const ctx = ctxOf(aliceId);
    const paused = (await run("schedules.pause", { scheduleId: t.id }, ctx)) as {
      task: { status: string; pauseReason: string };
    };
    expect(paused.task).toMatchObject({ status: "paused", pauseReason: "creator" });
    expect(await summary("schedules.pause", { scheduleId: t.id }, ctx)).toEqual({
      zh: "暂停定时任务「Daily digest」",
      en: 'Pause scheduled task "Daily digest"',
    });
    await expect(run("schedules.resume", { scheduleId: t.id }, ctx)).rejects.toThrow();
    expect(await run("schedules.delete", { scheduleId: t.id }, ctx)).toEqual({
      id: t.id,
      deleted: true,
    });
    const bobs = await createTask(bobId);
    await expect(run("schedules.pause", { scheduleId: bobs.id }, ctx)).rejects.toThrow();
    await expect(run("schedules.delete", { scheduleId: bobs.id }, ctx)).rejects.toThrow();
  });

  it("grants add, list and remove; run and runs", async () => {
    const t = await createTask();
    const ctx = ctxOf(aliceId);
    const grants = [{ toolKey: "AskUserQuestion" }];
    const added = (await run("schedules.grants-add", { scheduleId: t.id, grants }, ctx)) as {
      items: object[];
    };
    expect(added.items).toEqual([{ toolKey: "AskUserQuestion", connectorId: null }]);
    expect(await summary("schedules.grants-add", { scheduleId: t.id, grants }, ctx)).toEqual({
      zh: "为定时任务「Daily digest」预先批准工具：AskUserQuestion",
      en: 'Approve tools in advance for scheduled task "Daily digest": AskUserQuestion',
    });
    expect(await run("schedules.grants-list", { scheduleId: t.id }, ctx)).toEqual({
      items: [{ toolKey: "AskUserQuestion", connectorId: null, stale: false }],
    });
    expect(
      await run("schedules.grants-remove", { scheduleId: t.id, toolKey: "AskUserQuestion" }, ctx),
    ).toEqual({ id: t.id, toolKey: "AskUserQuestion", removed: true });
    expect(await run("schedules.grants-list", { scheduleId: t.id }, ctx)).toEqual({ items: [] });

    const r = (await run("schedules.run", { scheduleId: t.id, trial: true }, ctx)) as {
      run: { id: string; trial: boolean; status: string };
    };
    expect(r.run).toMatchObject({ trial: true });
    const runs = (await run("schedules.runs", { scheduleId: t.id }, ctx)) as {
      items: { id: string }[];
    };
    expect(runs.items.map((x) => x.id)).toContain(r.run.id);
    expect(await summary("schedules.run", { scheduleId: t.id, trial: true }, ctx)).toEqual({
      zh: "立即运行定时任务「Daily digest」（试运行）",
      en: 'Run scheduled task "Daily digest" now as a trial',
    });
  });
});
