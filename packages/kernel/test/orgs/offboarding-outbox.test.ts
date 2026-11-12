import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { Offboarding } from "../../src/orgs/offboarding.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RUN_JOB, RUN_QUEUE_NAME, runJobId } from "../../src/runtime/run-jobs.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { QuestionsService } from "../../src/tools/questions.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, kernelTransaction } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";

/**
 * Transactional outbox spec §8.1 (offboarding and devices rows): the offboard transaction owes a
 * `run-stop` job for each of the member's active runs and a `sandbox-destroy-for` job for each of
 * their devices; deleting a device owes its destroy under `device-destroy-<deviceId>`. Every
 * kernel add to the maintenance queue fails while `failing` is set (the `OUTBOX_DISPATCH_FAILS`
 * seam): the fast path delivers nothing, so what stops or destroys got there through an owed row an
 * explicit relay pass (`OutboxDispatcher.dispatchDue`) delivered.
 *
 * Also the lock order of offboarding against a reply that skips a sub-agent's network ask
 * (conversation trees are locked root first).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let ownerId: string;
let owner: Req;
/** While true, every kernel add to the maintenance queue fails. */
let failing = false;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-offboard-outbox-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failing && queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  failing = false;
});

/** A new account in `orgId` with a session. */
async function member(orgId: string): Promise<{ id: string; req: Req }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

async function insertAgent(orgId: string, by: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${id}, ${orgId}, ${by}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${id}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${by})`.execute(raw);
  return id;
}

async function insertConversation(
  orgId: string,
  agentId: string,
  accountId: string,
  opts: { id?: string; parent?: string } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  if (opts.parent === undefined) {
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${id}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  } else {
    await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_type, subagent_depth)
      VALUES (${id}, ${orgId}, ${agentId}, ${accountId}, 'subagent', ${opts.parent}, 'general', 1)`.execute(
      raw,
    );
  }
  return id;
}

async function insertRun(
  conversationId: string,
  accountId: string,
  status: "running" | "waiting",
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${id}, ${conversationId}, ${status}, 1, ${accountId}, 0)`.execute(raw);
  return id;
}

/** A pending approval row (a tool approval for `requestedFor`, or a network ask). */
async function insertApproval(
  a: { orgId: string; conversationId: string; runId: string; requestedFor: string },
  kind: "tool" | "network",
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.approvals
    (id, org_id, conversation_id, run_id, call_id, tool_key, spec_hash, input, requested_for,
     expires_at, kind, detail)
    VALUES (${id}, ${a.orgId}, ${a.conversationId}, ${a.runId}, ${randomUUID()},
      ${kind === "network" ? "Bash" : "mcp__docs__create_doc"}, 'h', '{}'::jsonb, ${a.requestedFor},
      now() + interval '1 hour', ${kind},
      ${kind === "network" ? JSON.stringify({ deviceId: randomUUID(), hosts: [{ host: "x.test" }] }) : null})`.execute(
    raw,
  );
  return id;
}

/** The owed (not dead) maintenance rows of a job name. */
const owed = (name: string) =>
  db
    .selectFrom("outbox")
    .select(["job_id", "data", "org_id"])
    .where("queue", "=", MAINTENANCE_QUEUE_NAME)
    .where("job_name", "=", name)
    .where("dead_at", "is", null)
    .orderBy("id")
    .execute();

/**
 * Lets the maintenance queue's adds succeed and runs relay passes until none of its rows is owed
 * (a pass of the worker's own relay may have claimed a row while the adds failed and pushed its
 * next attempt back: each pass brings every row's attempt forward first).
 */
async function relay(): Promise<void> {
  failing = false;
  await waitFor(
    async () => {
      await db
        .updateTable("outbox")
        .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
        .where("queue", "=", MAINTENANCE_QUEUE_NAME)
        .execute();
      await k.app.get(OutboxDispatcher).dispatchDue(500);
      const left = await db
        .selectFrom("outbox")
        .select("id")
        .where("queue", "=", MAINTENANCE_QUEUE_NAME)
        .where("dead_at", "is", null)
        .execute();
      return left.length === 0;
    },
    15_000,
    "the owed maintenance rows delivered",
  );
}

const runStatus = async (id: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const instanceOf = (deviceId: string) =>
  db
    .selectFrom("device_instances")
    .select("device_id")
    .where("device_id", "=", deviceId)
    .executeTakeFirst();

/** Creates the device's instance (runs `echo` in it). */
async function startInstance(orgId: string, accountId: string, deviceId: string): Promise<void> {
  const agentId = await insertAgent(orgId, accountId);
  const conversationId = await insertConversation(orgId, agentId, accountId);
  await k.app.get(SandboxService).withSandbox(
    { orgId, deviceId, holderConversationId: conversationId, actor: { accountId, conversationId } },
    async (h, p, _i, signal) => {
      await p.exec(h, { command: "echo hi", timeoutMs: 10_000, maxOutputBytes: 100, signal });
    },
    AbortSignal.timeout(30_000),
  );
  expect(await instanceOf(deviceId)).toBeDefined();
}

const removeMember = async (orgId: string, accountId: string) => {
  const res = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${accountId}` });
  expect(res.statusCode, res.body).toBe(204);
};

describe("offboarding owes its run stops and device destroys", () => {
  it("an offboarded member's running run stops with the fast path disabled", async () => {
    const orgId = await createOrg(owner, `Stop ${randomUUID().slice(0, 6)}`);
    const leaver = await member(orgId);
    const agentId = await insertAgent(orgId, leaver.id);
    const conv = await insertConversation(orgId, agentId, leaver.id);
    const runId = await insertRun(conv, leaver.id, "running");

    failing = true;
    await removeMember(orgId, leaver.id);
    // nothing reached the queue: the run still runs, its stop is owed
    expect(await runStatus(runId)).toBe("running");
    expect(await owed("run-stop")).toEqual([
      { job_id: `run-stop-${runId}`, data: { conversationId: conv, runId }, org_id: orgId },
    ]);

    await relay();
    expect(await owed("run-stop")).toEqual([]);
    await waitFor(async () => (await runStatus(runId)) === "aborted", 15_000, "run aborted");
  });

  it("an offboarded member's queued run is aborted in PG and never starts later (ruling R27)", async () => {
    const orgId = await createOrg(owner, `Queued ${randomUUID().slice(0, 6)}`);
    const leaver = await member(orgId);
    const agentId = await insertAgent(orgId, leaver.id);
    const conv = await insertConversation(orgId, agentId, leaver.id);
    const runId = randomUUID();
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
      VALUES (${runId}, ${conv}, 'queued', 1, ${leaver.id}, 0)`.execute(raw);
    // its job is held (delayed an hour): no worker has started it
    const connection = new Redis(rd.url, { maxRetriesPerRequest: null });
    const runs = new Queue(RUN_QUEUE_NAME, { connection });
    try {
      const job = await runs.add(
        RUN_JOB,
        { runId, conversationId: conv },
        { jobId: runJobId(conv, 0), delay: 3_600_000 },
      );

      failing = true;
      await removeMember(orgId, leaver.id);
      expect(await runStatus(runId)).toBe("queued");
      await relay();
      await waitFor(async () => (await runStatus(runId)) === "aborted", 15_000, "run aborted");
      // the stop marker is gone (an hour's TTL is not what keeps it from starting)
      await connection.del(`capk:run-abort:${runId}`);

      // the held job runs now: it finds the run finished and starts nothing
      await job.promote();
      await waitFor(
        async () => (await runs.getJobState(job.id as string)) !== "delayed",
        15_000,
        "the job left the delayed set",
      );
      await waitFor(
        async () =>
          ["completed", "failed", "unknown"].includes(await runs.getJobState(job.id as string)),
        15_000,
        "the job finished",
      );
      expect(await runStatus(runId)).toBe("aborted");
      const types = (
        await db
          .selectFrom("conversation_events")
          .select("type")
          .where("conversation_id", "=", conv)
          .execute()
      ).map((e) => e.type);
      expect(types).toContain("run_aborted");
      expect(types).not.toContain("run_started");
    } finally {
      await runs.close();
      connection.disconnect();
    }
  }, 30_000);

  it("their devices are destroyed with the fast path disabled", async () => {
    const orgId = await createOrg(owner, `Devs ${randomUUID().slice(0, 6)}`);
    const leaver = await member(orgId);
    const dev = await seedDevice(raw, orgId, leaver.id);
    await startInstance(orgId, leaver.id, dev);

    failing = true;
    await removeMember(orgId, leaver.id);
    expect(await instanceOf(dev)).toBeDefined();
    expect(await owed("sandbox-destroy-for")).toEqual([
      { job_id: `device-destroy-${dev}`, data: { deviceIds: [dev] }, org_id: orgId },
    ]);

    await relay();
    expect(await owed("sandbox-destroy-for")).toEqual([]);
    await waitFor(async () => (await instanceOf(dev)) === undefined, 15_000, "instance destroyed");
  });

  it("deleting a device destroys its instance with the fast path disabled", async () => {
    const orgId = await createOrg(owner, `Del ${randomUUID().slice(0, 6)}`);
    const person = await member(orgId);
    const res = await person.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices`,
      payload: { name: "Repo" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const dev = (res.json() as { device: { id: string } }).device.id;
    await startInstance(orgId, person.id, dev);

    failing = true;
    const del = await person.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/devices/${dev}` });
    expect(del.statusCode, del.body).toBe(202);
    expect(await instanceOf(dev)).toBeDefined();
    expect(await owed("sandbox-destroy-for")).toEqual([
      { job_id: `device-destroy-${dev}`, data: { deviceIds: [dev] }, org_id: orgId },
    ]);

    await relay();
    await waitFor(async () => (await instanceOf(dev)) === undefined, 15_000, "instance destroyed");
  });
});

describe("offboarding and a reply's skips lock conversation trees root first", () => {
  /**
   * How many backends wait, directly or through another waiter, on the backend `pid` (the test's
   * own lock holder): other sessions of the database never count.
   */
  const waitersOn = async (pid: number) => {
    const r = await sql<{ n: string }>`WITH RECURSIVE w(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*) AS n FROM w`.execute(raw);
    return Number(r.rows[0]?.n ?? 0);
  };

  it("a reply skipping a sub-agent's network ask and an offboarding cancelling asks in its tree both finish", async () => {
    const orgId = await createOrg(owner, `Cycle ${randomUUID().slice(0, 6)}`);
    const leaver = await member(orgId);
    const author = await member(orgId);
    const agentId = await insertAgent(orgId, author.id);
    // the child's id sorts before its root's: id order would lock the child first
    const rootId = await insertConversation(orgId, agentId, author.id, {
      id: `ffffffff${randomUUID().slice(8)}`,
    });
    const childId = await insertConversation(orgId, agentId, author.id, {
      id: `00000000${randomUUID().slice(8)}`,
      parent: rootId,
    });
    const rootRun = await insertRun(rootId, author.id, "waiting");
    const childRun = await insertRun(childId, author.id, "waiting");
    // the reply skips the root's question and the child's network ask (the author's runs)
    const question = await k.app.get(QuestionsService).ask({
      orgId,
      conversationId: rootId,
      runId: rootRun,
      step: 1,
      callId: "q1",
      attempt: 1,
      toolKey: "AskUserQuestion",
      form: { title: "Q", fields: [{ key: "x", label: "X", schema: { type: "string" } }] },
      state: null,
    });
    await insertApproval(
      { orgId, conversationId: childId, runId: childRun, requestedFor: author.id },
      "network",
    );
    // the offboarding cancels the leaver's approvals in both conversations
    await insertApproval(
      { orgId, conversationId: rootId, runId: rootRun, requestedFor: leaver.id },
      "tool",
    );
    await insertApproval(
      { orgId, conversationId: childId, runId: childRun, requestedFor: leaver.id },
      "tool",
    );

    // a holder of the root's question row stops the reply after it locked the root
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let held!: (pid: number) => void;
    const holding = new Promise<number>((r) => {
      held = r;
    });
    const holder = raw.transaction().execute(async (t) => {
      await sql`SELECT id FROM capybara.questions WHERE id = ${question.id} FOR UPDATE`.execute(t);
      const me = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(t);
      held(Number(me.rows[0]?.pid));
      await released;
    });
    const holderPid = await holding;

    const reply = kernelTransaction(k, async () => {
      const conversations = k.app.get(ConversationsService);
      await sql`SELECT id FROM capybara.conversations WHERE id = ${rootId} FOR UPDATE`.execute(
        k.app.get(KernelDb).db,
      );
      return conversations.skipWaitsIn(rootId, author.id, 100);
    });
    await waitFor(async () => (await waitersOn(holderPid)) >= 1, 10_000, "the reply waits");
    const offboard = kernelTransaction(k, () =>
      k.app.get(Offboarding).offboard(orgId, leaver.id, "directory"),
    );
    await waitFor(async () => (await waitersOn(holderPid)) >= 2, 10_000, "the offboarding waits");
    release();
    await holder;

    const [r, o] = await Promise.allSettled([reply, offboard]);
    expect(r.status === "rejected" ? String(r.reason) : "ok").toBe("ok");
    expect(o.status === "rejected" ? String(o.reason) : "ok").toBe("ok");
    const statuses = await db
      .selectFrom("approvals")
      .select(["kind", "requested_for", "status"])
      .where("org_id", "=", orgId)
      .execute();
    expect(statuses.filter((a) => a.kind === "network").map((a) => a.status)).toEqual(["skipped"]);
    expect(statuses.filter((a) => a.requested_for === leaver.id).map((a) => a.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});
