import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { MAINTENANCE_QUEUE_NAME, Waits, waitTimeoutJobId } from "../../src/runtime/waits.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 9 双副本：两个内核实例（各自的连接池、HTTP 应用与 worker，共用 PG / Redis）。
 * - A 副本执行到审批处暂停，A 停机后 B 副本收到审批决定并从 checkpoint 续跑；
 * - 同一审批的超时任务（B 的维护 worker）与人工决定（A 的 HTTP）竞争：恰好一条决定事件、只续跑一次。
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let maint: Queue;
/**
 * The client `maint` uses. A queue given a client does not close it, so afterAll quits it before
 * Redis stops: an open client without an error listener reports "[ioredis] Unhandled error event"
 * on every reconnect, which can land after Vitest tore the worker down.
 */
let maintRedis: Redis;
const kernels: TestKernel[] = [];

const config = () =>
  runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MEM_CONNECTOR] });
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

async function login(k: TestKernel, jar = cookieJar()): Promise<Req> {
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function boot(): Promise<TestKernel> {
  const k = await startKernel(config());
  kernels.push(k);
  return k;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  maintRedis = new Redis(rd.url);
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: maintRedis });
}, 120_000);

afterAll(async () => {
  await maint?.close();
  await maintRedis?.quit();
  for (const k of kernels) await k.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let agentId: string;

beforeEach(async () => {
  for (const k of kernels.splice(0)) await k.close();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  memState().echoCalls = 0;
});

async function setup(req: Req): Promise<void> {
  orgId = await createOrg(req);
  const en = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const ag = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
}

async function waitingApproval(req: Req, convId: string): Promise<{ runId: string; id: string }> {
  await postMessage(req, orgId, convId, ECHO);
  const ev = await waitForEvent(db, convId, (e) => e.type === "approval_requested");
  const runId = ev.runId as string;
  await waitFor(
    async () =>
      (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())
        ?.status === "waiting",
    10_000,
    "run waiting",
  );
  return {
    runId,
    id: (ev as Extract<ConversationEvent, { type: "approval_requested" }>).payload.approvalId,
  };
}

describe("双副本续跑", () => {
  // Boots two kernels in turn and stops one, with a run before and after: about 3 s alone, so the
  // default 5 s timeout fails under load; no fixed sleeps, every wait polls its real condition.
  it("A 副本暂停（随后停机），B 副本收到审批决定并从 checkpoint 续跑", {
    timeout: 30_000,
  }, async () => {
    const ka = await boot();
    const jar = cookieJar();
    const reqA = await login(ka, jar);
    await setup(reqA);
    const convId = await createConv(reqA, orgId, agentId);
    const { runId, id } = await waitingApproval(reqA, convId);
    // A 停机：之后只有 B 能执行续跑
    await ka.close();
    kernels.splice(kernels.indexOf(ka), 1);
    const kb = await boot();
    const reqB = asUser(kb.http, jar);
    const res = await reqB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().echoCalls).toBe(1);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(ofType(evs, "tool_result").map((e) => e.payload.content)).toEqual(['{"text":"hi"}']);
    // 第一步的模型回复复用（续跑不重新请求第一步）
    expect(ofType(evs, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
  });

  // Both paths act at once in every round; where the expiry sits (set on the PG clock, which both
  // paths compare under the approval's row lock) decides the winner, so no round sleeps for it.
  // About 1 s alone; the 30 s timeout is for heavy load.
  it("超时任务（B）与人工决定（A）竞争同一审批：恰好一条决定事件，只续跑一次", async () => {
    const ka = await boot();
    const kb = await boot();
    const jar = cookieJar();
    const reqA = await login(ka, jar);
    await setup(reqA);
    // Rounds: well before the expiry (the decision must win), past it (the timeout must win), and
    // right at it (either may win). The expiry is an offset from PG's now().
    const outcomes: string[] = [];
    for (const expiresIn of ["1 hour", "-1 second", "20 milliseconds"]) {
      const convId = await createConv(reqA, orgId, agentId);
      const { runId, id } = await waitingApproval(reqA, convId);
      const job = await waitFor(() => maint.getJob(waitTimeoutJobId(id)), 15_000, "timeout job");
      await sql`UPDATE capybara.approvals SET expires_at = now() + ${expiresIn}::interval
        WHERE id = ${id}`.execute(raw);
      const [decision] = await Promise.all([
        reqA({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
          payload: { decision: "approve" },
        }),
        job.promote(),
        kb.app.get(Waits).expire("approval", id),
        ka.app.get(Waits).resume(runId, id),
      ]);
      expect([200, 409]).toContain(decision.statusCode);
      await waitForTerminal(db, convId, 1);
      // A timeout job that ran before the expiry delayed itself again until it: promote it until it
      // has run to completion (removeOnComplete), so its late run is covered by the checks below.
      await waitFor(
        async () => {
          const j = await maint.getJob(waitTimeoutJobId(id));
          if (!j) return true;
          if (await j.isDelayed()) await j.promote().catch(() => undefined);
          return false;
        },
        15_000,
        "timeout job finished",
      );
      const evs = await eventsOf(db, convId);
      const decided = ofType(evs, "approval_decided");
      expect(decided).toHaveLength(1);
      expect(ofType(evs, "run_finished")).toHaveLength(1);
      expect(ofType(evs, "tool_result")).toHaveLength(1);
      // 每一步的模型调用各一次：续跑只发生一次
      expect(ofType(evs, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
      const approved = decided[0]?.payload.decision === "approved";
      expect(decision.statusCode).toBe(approved ? 200 : 409);
      outcomes.push(decided[0]?.payload.decision ?? "");
    }
    expect(outcomes.slice(0, 2)).toEqual(["approved", "expired"]);
  }, 30_000);
});
