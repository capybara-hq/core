import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/** The scheduled-tasks API (spec 2026-11-11-scheduled-tasks §10) on one kernel. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE] }));
}, 120_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let otherOrgId: string;
let aliceId: string;
let alice: Req;
let bob: Req;
let guest: Req;
let admin: Req;
let outsider: Req;
let agentId: string;

const base = (org = orgId) => `/api/v1/orgs/${org}/schedules`;
const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.deployment_settings");
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  const adminId = await mk("admin");
  aliceId = await mk("alice");
  const bobId = await mk("bob");
  const guestId = await mk("guest");
  await mk("outsider");
  const owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  alice = await session(k, "alice");
  bob = await session(k, "bob");
  guest = await session(k, "guest");
  admin = await session(k, "admin");
  outsider = await session(k, "outsider");
  otherOrgId = await createOrg(outsider, "Other");
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

const body = (over: Record<string, unknown> = {}) => ({
  agentId,
  name: "Daily digest",
  prompt: "Summarize yesterday.",
  trigger: { kind: "cron", expr: "0 9 * * *" },
  mode: "new",
  ...over,
});

type Task = {
  id: string;
  name: string;
  status: string;
  accountId: string;
  trigger: { timeZone: string };
};

async function create(req: Req, over: Record<string, unknown> = {}): Promise<Task> {
  const res = await req({ method: "POST", url: base(), payload: body(over) });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { task: Task }).task;
}

describe("schedules API", () => {
  it("create, get, list, update, pause, resume, delete", async () => {
    const t = await create(alice, { timeZone: "Asia/Shanghai" });
    expect(t).toMatchObject({ name: "Daily digest", status: "active", accountId: aliceId });
    // the browser zone applies because the account has none
    expect(t.trigger.timeZone).toBe("Asia/Shanghai");

    let res = await alice({ method: "GET", url: `${base()}/${t.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { task: Task }).task.id).toBe(t.id);

    res = await alice({ method: "GET", url: base() });
    expect((res.json() as { items: Task[] }).items.map((x) => x.id)).toEqual([t.id]);

    res = await alice({ method: "PATCH", url: `${base()}/${t.id}`, payload: { name: "Digest 2" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task.name).toBe("Digest 2");

    res = await alice({ method: "POST", url: `${base()}/${t.id}/pause` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task.status).toBe("paused");

    res = await alice({ method: "POST", url: `${base()}/${t.id}/resume` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { task: Task }).task.status).toBe("active");

    res = await alice({ method: "DELETE", url: `${base()}/${t.id}` });
    expect(res.statusCode, res.body).toBe(204);
    res = await alice({ method: "GET", url: `${base()}/${t.id}` });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe("schedule.not_found");
  });

  it("run now, runs and grants", async () => {
    const t = await create(alice);
    let res = await alice({
      method: "POST",
      url: `${base()}/${t.id}/run`,
      payload: { trial: true },
    });
    expect(res.statusCode, res.body).toBe(202);
    const run = (res.json() as { run: { id: string; trial: boolean } }).run;
    expect(run.trial).toBe(true);

    res = await alice({ method: "GET", url: `${base()}/${t.id}/runs?limit=5` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: { id: string }[] }).items.map((r) => r.id)).toContain(run.id);

    res = await alice({
      method: "POST",
      url: `${base()}/${t.id}/grants`,
      payload: { grants: [{ toolKey: "AskUserQuestion" }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ toolKey: "AskUserQuestion", connectorId: null }),
    ]);

    res = await alice({ method: "GET", url: `${base()}/${t.id}/grants` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: { toolKey: string }[] }).items.map((g) => g.toolKey)).toEqual([
      "AskUserQuestion",
    ]);

    res = await alice({ method: "DELETE", url: `${base()}/${t.id}/grants/AskUserQuestion` });
    expect(res.statusCode, res.body).toBe(204);
    res = await alice({ method: "GET", url: `${base()}/${t.id}/grants` });
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("admin lists every task with all=true; a member may not", async () => {
    const t = await create(alice);
    let res = await admin({ method: "GET", url: base() });
    expect((res.json() as { items: Task[] }).items).toEqual([]);
    res = await admin({ method: "GET", url: `${base()}?all=true` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: Task[] }).items.map((x) => x.id)).toEqual([t.id]);

    res = await bob({ method: "GET", url: `${base()}?all=true` });
    expect(res.statusCode).toBe(403);
    // another member's task is invisible
    res = await bob({ method: "GET", url: `${base()}/${t.id}` });
    expect(res.statusCode).toBe(404);
    // an admin pauses it, but cannot edit it
    res = await admin({ method: "POST", url: `${base()}/${t.id}/pause` });
    expect(res.statusCode, res.body).toBe(200);
    res = await admin({ method: "PATCH", url: `${base()}/${t.id}`, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe("schedule.forbidden");
  });

  it("a guest gets 403 except pause and delete of a task it created before being demoted", async () => {
    let res = await guest({ method: "GET", url: base() });
    expect(res.statusCode).toBe(403);
    res = await guest({ method: "POST", url: base(), payload: body() });
    expect(res.statusCode).toBe(403);

    const t = await create(alice);
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("account_id", "=", aliceId)
      .execute();
    res = await alice({ method: "PATCH", url: `${base()}/${t.id}`, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
    res = await alice({ method: "POST", url: `${base()}/${t.id}/resume` });
    expect(res.statusCode).toBe(403);
    res = await alice({ method: "POST", url: `${base()}/${t.id}/pause` });
    expect(res.statusCode, res.body).toBe(200);
    res = await alice({ method: "DELETE", url: `${base()}/${t.id}` });
    expect(res.statusCode, res.body).toBe(204);
    // a guest cannot touch someone else's task
    const other = await create(bob);
    res = await alice({ method: "POST", url: `${base()}/${other.id}/pause` });
    expect(res.statusCode).toBe(404);
    res = await alice({ method: "DELETE", url: `${base()}/${other.id}` });
    expect(res.statusCode).toBe(404);
  });

  it("another org is 404, never the task", async () => {
    const t = await create(alice);
    let res = await outsider({ method: "GET", url: `${base()}/${t.id}` });
    // not a member of the org: the guard answers 404 without disclosing it
    expect(res.statusCode).toBe(404);
    res = await outsider({ method: "GET", url: `${base(otherOrgId)}/${t.id}` });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe("schedule.not_found");
    res = await outsider({ method: "DELETE", url: `${base(otherOrgId)}/${t.id}` });
    expect(res.statusCode).toBe(404);
  });

  it("validates the body: bounds, strictness, model format, effort", async () => {
    const bad = async (over: Record<string, unknown>) =>
      (await alice({ method: "POST", url: base(), payload: body(over) })).statusCode;
    expect(await bad({ name: "x".repeat(201) })).toBe(400);
    expect(await bad({ prompt: "x".repeat(20_001) })).toBe(400);
    expect(await bad({ model: "no-object" })).toBe(400);
    expect(await bad({ model: { provider: "a", model: "b".repeat(300) } })).toBe(400);
    expect(await bad({ model: "model-fake/fake-1" })).toBe(400);
    expect(await bad({ effort: "extreme" })).toBe(400);
    expect(await bad({ timeZone: "Mars/Base" })).toBe(400);
    expect(await bad({ extra: 1 })).toBe(400);
    expect(await bad({ model: { provider: "model-fake", model: "fake-1" }, effort: "low" })).toBe(
      201,
    );
  });

  it("a service token gets 403, org.read routes included", async () => {
    const t = await create(alice);
    const owner = await session(k, "owner");
    const made = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/service-tokens`,
      payload: { name: "ci", role: "admin" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const { token } = made.json() as { token: string };
    const headers = { authorization: `Bearer ${token}` };
    for (const [method, url] of [
      ["GET", base()],
      ["POST", `${base()}/${t.id}/pause`],
      ["DELETE", `${base()}/${t.id}`],
    ] as const) {
      const res = await k.http.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("operations that create or change a task or its grants are never remembered", () => {
    const ops = k.app.get(PlatformOperations);
    for (const id of [
      "schedules.create",
      "schedules.update",
      "schedules.delete",
      "schedules.run",
      "schedules.grants-add",
      "schedules.grants-remove",
    ]) {
      expect(ops.get(id), id).toMatchObject({ confirm: "personal", rememberable: false });
    }
    for (const id of [
      "schedules.list",
      "schedules.get",
      "schedules.runs",
      "schedules.grants-list",
    ]) {
      expect(ops.get(id), id).toMatchObject({ confirm: "read" });
    }
    expect(ops.get("schedules.pause")?.authz).toEqual({ orgAction: "org.read" });
  });
});
