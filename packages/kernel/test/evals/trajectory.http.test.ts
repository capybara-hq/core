import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { TrajectoryRun } from "../../src/evals/trajectory.js";
import type { TrajectoryListItem } from "../../src/evals/trajectory.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
} from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let eventLog: EventLog;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  eventLog = new EventLog(db, { publish: async () => {} });
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let alice: Req;
let bob: Req;
let ea: Req;
let guest: Req;
let ownerId: string;
let aliceId: string;
let bobId: string;
let orgId: string;
let agentA: string;
let agentO: string;
let convAlice: string;
let convBob: string;
let convOwner: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const USAGE = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 一次完成的运行：一次模型调用、一段文本。 */
async function seedRun(convId: string, runId: string, triggerAccountId: string): Promise<void> {
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status: "completed",
      agent_version: 1,
      trigger_account_id: triggerAccountId,
      started_at: new Date(),
      finished_at: new Date(),
    })
    .execute();
  await eventLog.append(convId, [
    {
      type: "run_started",
      runId,
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId,
      },
    },
    {
      type: "model_call",
      runId,
      payload: {
        step: 0,
        attempt: 0,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: { fromSeq: 1, toSeq: 1, summarySeq: null, systemHash: "h", reminderSeqs: [] },
      },
    },
    {
      type: "assistant_message",
      runId,
      payload: { step: 0, content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    },
    {
      type: "usage",
      runId,
      payload: { step: 0, provider: "model-fake", model: "fake-1", ...USAGE },
    },
    { type: "run_finished", runId, payload: { reason: "completed", consumedUpToSeq: 0 } },
  ]);
}

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_prices, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  const mk = async (login: string, enterpriseAdmin = false) =>
    (await accounts.createLocal({ login, password: PW, displayName: login, enterpriseAdmin })).id;
  ownerId = await mk("owner");
  aliceId = await mk("alice");
  bobId = await mk("bob");
  await mk("entadmin", true);
  const guestId = await mk("guest");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const members = testMembers(db);
  await members.add(orgId, aliceId, "member", ownerId);
  await members.add(orgId, bobId, "member", ownerId);
  await members.add(orgId, guestId, "guest", ownerId);
  alice = await session(k, "alice");
  bob = await session(k, "bob");
  ea = await session(k, "entadmin");
  guest = await session(k, "guest");

  agentA = await createAgent(alice, orgId); // alice 负责
  agentO = await createAgent(owner, orgId); // owner 负责
  convAlice = await createConv(alice, orgId, agentA);
  convBob = await createConv(bob, orgId, agentA);
  convOwner = await createConv(owner, orgId, agentO);
  await seedRun(convAlice, "run-a", aliceId);
  await seedRun(convBob, "run-b", bobId);
  await db
    .insertInto("model_prices")
    .values({
      provider: "model-fake",
      model: "fake-1",
      input_per_mtok: "2",
      output_per_mtok: "10",
      cache_read_per_mtok: null,
      cache_write_per_mtok: null,
      updated_by: ownerId,
    })
    .execute();
});

const viewedCount = async () =>
  (
    await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "org_id"])
      .where("action", "=", "trajectory.viewed")
      .execute()
  ).length;

const detail = (req: Req, convId: string) =>
  req({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${convId}` });

interface Detail {
  conversation: {
    id: string;
    agentId: string;
    accountId: string;
    title: string | null;
    kind: string;
  };
  runs: TrajectoryRun[];
  currency: string;
}

describe("GET /orgs/:orgId/trajectories/:conversationId", () => {
  it("负责人 200；非负责人成员 404；非成员的企业管理员 404；admin 200；每次 200 记一条审计", async () => {
    const before = await viewedCount();
    const a = await detail(alice, convBob);
    expect(a.statusCode, a.body).toBe(200);
    const body = a.json() as Detail;
    expect(body.conversation).toEqual({
      id: convBob,
      agentId: agentA,
      accountId: bobId,
      title: null,
      kind: "chat",
    });
    expect(body.currency).toBe("USD");
    expect(body.runs).toHaveLength(1);
    const run = body.runs[0];
    expect(run?.runId).toBe("run-b");
    expect(run?.steps[0]?.text).toBe("hello");
    expect(run?.totals.usage).toEqual(USAGE);
    expect(run?.totals.cost).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 12);
    expect(await viewedCount()).toBe(before + 1);

    const b = await detail(bob, convBob);
    expect(b.statusCode).toBe(404);
    expect(errCode(b)).toBe("trajectory.not_found");

    const e = await detail(ea, convBob);
    expect(e.statusCode).toBe(404);

    const g = await detail(guest, convBob);
    expect(g.statusCode).toBe(403);

    const o = await detail(owner, convAlice);
    expect(o.statusCode).toBe(200);
    expect(await viewedCount()).toBe(before + 2);

    const audit = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "org_id", "detail"])
      .where("action", "=", "trajectory.viewed")
      .orderBy("id")
      .execute();
    expect(audit.map((r) => [r.actor_account_id, r.target, r.org_id])).toEqual([
      [aliceId, convBob, orgId],
      [ownerId, convAlice, orgId],
    ]);
    expect(audit[0]?.detail).toMatchObject({ agentId: agentA });
  });

  it("不存在的对话 404；负责人变更后实时生效", async () => {
    const missing = await detail(owner, "nope");
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("trajectory.not_found");
    // 负责人改为 bob：bob 立刻能看，alice 立刻不能看
    await db
      .updateTable("agents")
      .set({ owner_account_id: bobId })
      .where("id", "=", agentA)
      .execute();
    expect((await detail(bob, convAlice)).statusCode).toBe(200);
    expect((await detail(alice, convAlice)).statusCode).toBe(404);
    expect(await viewedCount()).toBe(1);
  });

  it("未登录 401", async () => {
    const res = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/trajectories/${convAlice}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /orgs/:orgId/trajectories", () => {
  const list = (req: Req, query = "") =>
    req({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories${query}` });
  type Page = { items: TrajectoryListItem[]; next: string | null };

  it("admin 看全部，负责人只看自己负责的 agent，其他成员为空", async () => {
    const o = await list(owner);
    expect(o.statusCode, o.body).toBe(200);
    const all = o.json() as Page;
    expect(all.items.map((i) => i.conversationId).sort()).toEqual(
      [convAlice, convBob, convOwner].sort(),
    );
    expect(all.next).toBeNull();
    const bobItem = all.items.find((i) => i.conversationId === convBob);
    expect(bobItem).toMatchObject({
      agentId: agentA,
      agentName: "Helper",
      accountId: bobId,
      title: null,
      lastRun: { runId: "run-b", status: "completed" },
    });
    expect(typeof bobItem?.updatedAt).toBe("string");
    expect(all.items.find((i) => i.conversationId === convOwner)?.lastRun).toBeNull();

    const a = (await list(alice)).json() as Page;
    expect(a.items.map((i) => i.conversationId).sort()).toEqual([convAlice, convBob].sort());
    const b = await list(bob);
    expect(b.statusCode).toBe(200);
    expect((b.json() as Page).items).toEqual([]);

    // agentId 过滤
    const filtered = (await list(owner, `?agentId=${agentO}`)).json() as Page;
    expect(filtered.items.map((i) => i.conversationId)).toEqual([convOwner]);
    // 列表不写审计（不含对话内容）
    expect(await viewedCount()).toBe(0);
  });

  it("分页：按 updated_at 倒序，next 作为 before 传回；limit 上限 100", async () => {
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 5; i++) {
      const q = `?limit=1${before === null ? "" : `&before=${before}`}`;
      const page = (await list(owner, q)).json() as Page;
      seen.push(...page.items.map((x) => x.conversationId));
      before = page.next;
      if (before === null) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    const full = ((await list(owner)).json() as Page).items.map((x) => x.conversationId);
    expect(seen).toEqual(full);

    for (const q of ["?limit=101", "?limit=0", "?kind=other"]) {
      const res = await list(owner, q);
      expect(res.statusCode, q).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    // 种子对话都是 chat；eval 对话的列出见 sets.http.test.ts
    const chat = (await list(owner, "?kind=chat")).json() as Page;
    expect(chat.items).toHaveLength(3);
    const evals = await list(owner, "?kind=eval");
    expect(evals.statusCode).toBe(200);
    expect((evals.json() as Page).items).toEqual([]);
    expect((await list(ea)).statusCode).toBe(404);
    expect((await list(guest)).statusCode).toBe(403);
  });
});
