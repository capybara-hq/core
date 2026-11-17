import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { ORG_ADMISSION_SPACE, XactLock } from "../../src/infra/database/xact-lock.js";
import { OrgLock } from "../../src/orgs/org-lock.js";
import type { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import type { LoopDeps } from "../../src/runtime/langgraph-loop.js";
import type { LoopContext, LoopOutcome } from "../../src/runtime/loop.js";
import { STOP_DELETED_ORG_JOB } from "../../src/runtime/run-deletion.js";
import { withExclusiveAdmission } from "../../src/runtime/run-execution.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "../../src/runtime/run-steps.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  gate,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Run fence admission (run fence shared admission spec). The run loop's own hot-path writes
 * (event appends, checkpoint writes, the suspend: `admission: "shared"`) are admitted under the
 * org admission lock shared (`pg_advisory_xact_lock_shared`), so the runs of one org append in
 * parallel; every other fenced write, and every write inside a tool step
 * (`withExclusiveAdmission`), is admitted exclusively (the org row `FOR NO KEY UPDATE`, as
 * `OrgLock`). Org deletion and offboarding take the admission lock exclusively first, then the org
 * row: they wait for the admitted hot-path writes, are not starved by them, and keep the lock
 * order of a tool step's writes (org row → conversations → agents / memberships).
 *
 * Two replicas, one run slot each (`workerConcurrency: 1`), so the two runs of a case execute on
 * different replicas. The seam: a test agent loop (`AGENT_LOOP_FACTORY`) that runs a per
 * conversation script inside the run's claim; a script opens fenced transactions (the fence takes
 * its locks first), reports its backend pid and waits on gates. Waits are on the specific blocked
 * backend (`pg_blocking_pids` of a holder the script reported, and the waiting statement's text).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
const replicas: { name: string; k: TestKernel }[] = [];
let ownerId: string;
let req: Req;

interface ScriptEnv {
  ctx: LoopContext;
  deps: LoopDeps;
  checkpoints: KyselyCheckpointSaver;
  host: TransactionHost;
  /** The replica's own providers (a `mandatory` provider joins only its own pool's transaction). */
  get: TestKernel["app"]["get"];
  replica: string;
}

/** What a conversation's run does inside its claim; returns the loop outcome. */
type Script = (env: ScriptEnv) => Promise<LoopOutcome["kind"]>;

const scripts = new Map<string, Script>();

/** The script's own backend pid (inside a transaction). */
async function backendPid(host: TransactionHost): Promise<number> {
  const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
    host.current() as NonNullable<ReturnType<TransactionHost["current"]>>,
  );
  return (r.rows[0] as { pid: number }).pid;
}

function loopFor(name: string, kernel: () => TestKernel): AgentLoopFactory {
  const host = () => kernel().app.get(TransactionHost);
  return (deps, checkpoints) => ({
    run: async (ctx: LoopContext): Promise<LoopOutcome> => {
      const evs = await deps.eventLog.readAfter(ctx.conversationId, 0, 1000);
      const consumedUpToSeq = Math.max(
        0,
        ...evs.filter((e) => e.type === "user_message").map((e) => e.seq),
      );
      const script = scripts.get(ctx.conversationId);
      scripts.delete(ctx.conversationId);
      const kind = script
        ? await script({
            ctx,
            deps,
            checkpoints,
            host: host(),
            get: (token: never) => kernel().app.get(token),
            replica: name,
          })
        : "completed";
      return kind === "aborted" ? { kind: "aborted" } : { kind: "completed", consumedUpToSeq };
    },
  });
}

/** A held transaction: the script reports its pid and waits for `release`. */
interface Hold {
  pid: Promise<number>;
  replica: Promise<string>;
  release: () => void;
  /** "ok" or the error message of what the script did after the release. */
  after: Promise<string>;
}

function holdHandles(): Hold & {
  arrive: (pid: number, replica: string) => void;
  released: Promise<void>;
  settle: (s: string) => void;
} {
  const rel = gate();
  let arrive!: (pid: number, replica: string) => void;
  let resolveReplica!: (r: string) => void;
  const replica = new Promise<string>((r) => {
    resolveReplica = r;
  });
  const pid = new Promise<number>((r) => {
    arrive = (p, rep) => {
      resolveReplica(rep);
      r(p);
    };
  });
  let settle!: (s: string) => void;
  const after = new Promise<string>((r) => {
    settle = r;
  });
  return { pid, replica, release: rel.open, released: rel.promise, arrive, after, settle };
}

const releasers: (() => void)[] = [];

/**
 * Registers a script for `conv`: inside the claim it opens one fenced transaction (`admission`
 * shared or exclusive), reports its pid, waits for the release, runs `inside` (still in the
 * transaction), commits; then runs `afterwards` (outside, e.g. a checkpoint write).
 */
function holdIn(
  conv: string,
  opts: {
    admission: "shared" | "exclusive";
    inside?: (env: ScriptEnv) => Promise<void>;
    afterwards?: (env: ScriptEnv) => Promise<unknown>;
    awaitAbort?: boolean;
  },
): Hold {
  const h = holdHandles();
  releasers.push(h.release);
  scripts.set(conv, async (env) => {
    try {
      const body = async () => {
        h.arrive(await backendPid(env.host), env.replica);
        await h.released;
        await opts.inside?.(env);
      };
      if (opts.admission === "shared") await env.host.run(body, { admission: "shared" });
      else await withExclusiveAdmission(() => env.host.run(body));
      await opts.afterwards?.(env);
      h.settle("ok");
    } catch (e) {
      h.settle(e instanceof Error ? e.message : String(e));
      throw e;
    }
    if (opts.awaitAbort) {
      if (!env.ctx.signal.aborted) {
        await new Promise((r) => env.ctx.signal.addEventListener("abort", r, { once: true }));
      }
      return "aborted";
    }
    return "completed";
  });
  return h;
}

/** Rejects when `p` has not settled within `ms` (a bound on a wait, not a sleep). */
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * True once a backend whose statement contains every one of `parts` waits for a lock held by one
 * of `holders` (`pg_blocking_pids`): the specific waiter, not any lock wait in the database.
 */
async function blockedBy(holders: number[], ...parts: string[]): Promise<boolean> {
  const r = await sql<{ query: string; blockers: number[] }>`
    SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(raw);
  return r.rows.some(
    (row) =>
      row.blockers.some((b) => holders.includes(b)) &&
      parts.every((p) => row.query.toLowerCase().includes(p.toLowerCase())),
  );
}

/** The backends holding the org admission lock of `orgId` in `mode` (granted). */
async function admissionHolders(orgId: string, mode: "ShareLock" | "ExclusiveLock") {
  const r = await sql<{ pid: number }>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 2 AND granted AND mode = ${mode}
      AND classid = hashtext(${ORG_ADMISSION_SPACE})::oid AND objid = hashtext(${orgId})::oid`.execute(
    raw,
  );
  return r.rows.map((x) => x.pid);
}

/** True while some backend waits for the org admission lock of `orgId` shared (queued). */
async function sharedAdmissionQueued(orgId: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 2 AND NOT granted AND mode = 'ShareLock'
      AND classid = hashtext(${ORG_ADMISSION_SPACE})::oid AND objid = hashtext(${orgId})::oid`.execute(
    raw,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** Tracks whether a promise has settled (the waiting write must not finish while runs hold). */
function track<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let done = false;
  const q = p.finally(() => {
    done = true;
  });
  return { p: q, settled: () => done };
}

const statusOf = async (conv: string, runId: string) =>
  (await runsOf(db, conv)).find((r) => r.id === runId)?.status;

async function runIdOf(conv: string): Promise<string> {
  return waitFor(async () => (await runsOf(db, conv))[0]?.id, 15_000, "run row");
}

const waitStatus = (conv: string, runId: string, status: string) =>
  waitFor(async () => (await statusOf(conv, runId)) === status, 15_000, `run ${status}`);

const checkpoint = (env: ScriptEnv) =>
  env.checkpoints.put(
    { configurable: { thread_id: env.ctx.runId } },
    emptyCheckpoint(),
    { source: "loop", step: 1, parents: {} },
    {},
  );

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const config = runConfig({ pg: pgc.url, redis: rd.url }, { runtime: { workerConcurrency: 1 } });
  for (const name of ["a", "b"]) {
    const entry: { name: string; k?: TestKernel } = { name };
    const k = await startKernel(config, {
      overrides: [
        {
          provide: AGENT_LOOP_FACTORY,
          useValue: loopFor(name, () => entry.k as TestKernel),
        },
      ],
    });
    entry.k = k;
    replicas.push({ name, k });
  }
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  req = await session((replicas[0] as { k: TestKernel }).k, "owner");
});

/** Lets every held run go (a failed case must not keep the replicas' run slots). */
function releaseAll(): void {
  for (const r of releasers.splice(0)) r();
  scripts.clear();
}

afterEach(releaseAll);

afterAll(async () => {
  releaseAll();
  for (const { k } of replicas) await k.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const kernelA = () => (replicas[0] as { k: TestKernel }).k;

async function member(orgId: string, role: "member" | "admin" = "member") {
  const login = `m-${Math.random().toString(36).slice(2, 10)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, role, ownerId);
  return { id, login };
}

async function orgWithConvs(name: string, n: number) {
  const orgId = await createOrgWithProviders(kernelA(), req, name);
  const agentId = await createAgent(req, orgId);
  const convs: string[] = [];
  for (let i = 0; i < n; i++) convs.push(await createConv(req, orgId, agentId));
  return { orgId, agentId, convs };
}

describe("hot-path writes of two runs in one org", () => {
  it("are admitted at once: both hold the admission lock shared on two replicas", async () => {
    const { orgId, convs } = await orgWithConvs("Parallel", 2);
    const hs = convs.map((c) => holdIn(c, { admission: "shared", afterwards: checkpoint }));
    for (const c of convs) await postMessage(req, orgId, c, "hi");
    // both reach the seam before either is released: no mutual exclusion
    const pids = await within(Promise.all(hs.map((h) => h.pid)), 15_000, "both runs held");
    expect(new Set(await Promise.all(hs.map((h) => h.replica))).size).toBe(2);
    expect((await admissionHolders(orgId, "ShareLock")).sort()).toEqual([...pids].sort());
    const runIds = await Promise.all(convs.map(runIdOf));
    for (const h of hs) h.release();
    expect(await Promise.all(hs.map((h) => h.after))).toEqual(["ok", "ok"]);
    for (const [i, conv] of convs.entries())
      await waitStatus(conv, runIds[i] as string, "completed");
  });

  it("an org admin write does not wait for them", async () => {
    const { orgId, convs } = await orgWithConvs("Admin write", 2);
    const hs = convs.map((c) => holdIn(c, { admission: "shared" }));
    for (const c of convs) await postMessage(req, orgId, c, "hi");
    await within(Promise.all(hs.map((h) => h.pid)), 15_000, "both runs held");
    const m = await member(orgId);
    const res = await within(
      req({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/members/${m.id}`,
        payload: { role: "admin" },
      }),
      10_000,
      "role change",
    );
    expect(res.statusCode, res.body).toBe(200);
    for (const h of hs) h.release();
    expect(await Promise.all(hs.map((h) => h.after))).toEqual(["ok", "ok"]);
  });
});

describe("beside a run's open tool-step transaction (exclusive admission)", () => {
  it("another run's real appends and checkpoints go through; its tool-step write waits", async () => {
    const { orgId, convs } = await orgWithConvs("Tool step", 2);
    const [toolConv, hotConv] = convs as [string, string];
    // the hot run is claimed first (a claim takes the org row like any exclusive admission)
    const hotStarted = gate();
    const hotGo = gate();
    const hotReached = gate();
    const toolWrite = gate();
    let hotOutcome = "";
    scripts.set(hotConv, async (env) => {
      hotStarted.open();
      await hotGo.promise;
      // the run loop's own writes: EventLog.append and a checkpoint (both admission: shared)
      await env.deps.eventLog.append(env.ctx.conversationId, [
        {
          type: "model_switched",
          runId: env.ctx.runId,
          idemKey: `fence-test:${env.ctx.runId}`,
          payload: { model: null, effort: null, byAccountId: null, reason: "unavailable" },
        },
      ]);
      await checkpoint(env);
      hotOutcome = "hot-path done";
      hotReached.open();
      await toolWrite.promise;
      // the same write inside a tool step is admitted exclusively: it waits for the org row
      await withExclusiveAdmission(() => checkpoint(env));
      return "completed";
    });
    await postMessage(req, orgId, hotConv, "hi");
    await within(hotStarted.promise, 15_000, "hot run started");
    releasers.push(hotGo.open, toolWrite.open);
    const tool = holdIn(toolConv, { admission: "exclusive" });
    await postMessage(req, orgId, toolConv, "hi");
    const toolPid = await within(tool.pid, 15_000, "tool step held");
    hotGo.open();
    await within(hotReached.promise, 15_000, "hot-path writes while the tool step holds");
    expect(hotOutcome).toBe("hot-path done");
    toolWrite.open();
    await waitFor(
      () => blockedBy([toolPid], "orgs", "deleted_at", "for no key update"),
      10_000,
      "the tool-step write waiting for the org row",
    );
    tool.release();
    expect(await tool.after).toBe("ok");
    const runId = await runIdOf(hotConv);
    await waitStatus(hotConv, runId, "completed");
  });
});

describe("org deletion", () => {
  it("waits for admitted hot-path writes, then revokes the runs without a deadlock", async () => {
    const { orgId, convs } = await orgWithConvs("Deleted", 2);
    const hs = convs.map((c) => holdIn(c, { admission: "shared", afterwards: checkpoint }));
    for (const c of convs) await postMessage(req, orgId, c, "hi");
    const pids = await within(Promise.all(hs.map((h) => h.pid)), 15_000, "both runs held");
    const runIds = await Promise.all(convs.map(runIdOf));
    const deletion = track(req({ method: "DELETE", url: `/api/v1/orgs/${orgId}` }));
    // the deletion takes the admission lock exclusively: it waits for the admitted writes
    await waitFor(
      () => blockedBy(pids, "pg_advisory_xact_lock(hashtext"),
      10_000,
      "deletion waiting for the admission lock",
    );
    expect(deletion.settled()).toBe(false);
    for (const h of hs) h.release();
    const res = await within(deletion.p, 10_000, "deletion");
    expect(res.statusCode, res.body).toBe(204);
    // the runs' next fenced write (a checkpoint, its own requires_new transaction) is refused
    expect(await Promise.all(hs.map((h) => h.after))).toEqual([
      "execution revoked",
      "execution revoked",
    ]);
    await drainOutbox(kernelA().app, { jobName: STOP_DELETED_ORG_JOB });
    for (const [i, conv] of convs.entries()) {
      const runId = runIds[i] as string;
      await waitStatus(conv, runId, "aborted");
      const evs = (await eventsOf(db, conv)).filter((e) => e.runId === runId);
      expect(evs.find((e) => e.type === "run_aborted")?.payload).toMatchObject({
        reason: "org_deleted",
      });
      expect(evs.map((e) => e.type)).not.toContain("run_finished");
    }
  });

  it("is not starved by two runs whose hot-path writes always overlap", async () => {
    const { orgId, convs } = await orgWithConvs("Streaming", 2);
    /** The bound of each run's write loop: reaching it means the deletion was starved. */
    const MAX_WRITES = 2_000;
    const entered = [0, 0];
    const ended: (string | undefined)[] = [undefined, undefined];
    const started = gate();
    const deletionSent = { done: false };
    // A relay: run 0 leaves write i once run 1 is inside write i; run 1 leaves write i once run 0
    // is inside write i + 1, so one of them always holds the admission lock shared. A run also
    // leaves once a shared admission is queued (behind the deletion; the other run, blocked) or
    // the other run ended, so the test itself never waits on a blocked run.
    const relay = (r: 0 | 1): Script => {
      const other = r === 0 ? 1 : 0;
      return async (env) => {
        try {
          for (let i = 1; i <= MAX_WRITES; i++) {
            await env.host.run(
              async () => {
                entered[r] = i;
                if (r === 1 && i === 5) started.open();
                const target = r === 0 ? i : i + 1;
                await waitFor(
                  async () =>
                    (entered[other] as number) >= target ||
                    ended[other] !== undefined ||
                    (deletionSent.done && (await sharedAdmissionQueued(orgId))),
                  30_000,
                  "the relay",
                  1,
                );
              },
              { admission: "shared" },
            );
          }
          ended[r] = "max";
        } catch (e) {
          ended[r] = e instanceof Error ? e.message : String(e);
          throw e;
        }
        return "completed";
      };
    };
    scripts.set(convs[0] as string, relay(0));
    scripts.set(convs[1] as string, relay(1));
    for (const c of convs) await postMessage(req, orgId, c, "hi");
    await within(started.promise, 15_000, "both runs writing");
    deletionSent.done = true;
    const res = await within(
      req({ method: "DELETE", url: `/api/v1/orgs/${orgId}` }),
      30_000,
      "deletion",
    );
    expect(res.statusCode, res.body).toBe(204);
    await waitFor(async () => ended.every((e) => e !== undefined), 15_000, "both relays ended");
    // both runs stopped at a write refused after the deletion, not at their loop's bound
    expect(ended).toEqual(["execution revoked", "execution revoked"]);
    expect(Math.max(...entered)).toBeLessThan(MAX_WRITES);
  });

  it("does not deadlock with rejecting a pending upload (an org foreign key check)", async () => {
    const orgId = await createOrgWithProviders(kernelA(), req, "Upload");
    const itemId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: `upload-${itemId.slice(0, 8)}`,
        package_name: `@acme/plugin-upload-${itemId.slice(0, 8)}`,
        publisher: "Acme",
        description: "upload",
        latest_version: "1.0.0",
        policy: "allow",
        owner_org_id: orgId,
      })
      .execute();
    // the rejection's order: the catalog item FOR UPDATE, then an org notice (a foreign key check,
    // FOR KEY SHARE on the org row) while the deletion waits for the item
    const locked = gate();
    const insert = gate();
    let rejectPid = 0;
    const reject = raw.transaction().execute(async (t) => {
      rejectPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(t)).rows[0]
        ?.pid as number;
      await sql`SELECT id FROM capybara.catalog_items WHERE id = ${itemId} FOR UPDATE`.execute(t);
      locked.open();
      await insert.promise;
      await sql`INSERT INTO capybara.org_notices (id, org_id, kind, detail)
        VALUES (${randomUUID()}, ${orgId}, 'upload_rejected', '{}'::jsonb)`.execute(t);
    });
    await locked.promise;
    const deletion = track(req({ method: "DELETE", url: `/api/v1/orgs/${orgId}` }));
    await waitFor(
      () => blockedBy([rejectPid], "catalog_items"),
      10_000,
      "deletion waiting for the catalog item",
    );
    insert.open();
    await within(reject, 10_000, "the rejection");
    const res = await within(deletion.p, 10_000, "deletion");
    expect(res.statusCode, res.body).toBe(204);
  });
});

describe("offboarding a member while their run is in a tool step", () => {
  /**
   * What the tool step locks after the fence (and so after the member's conversation): an Agent
   * dispatch, the org's agents `FOR SHARE`; the first default device of the person, the org row
   * and the membership `FOR SHARE` (`DevicesService.insertDefault`). Offboarding locks the org row,
   * the membership, the agents and then the member's conversations.
   */
  const patterns: [
    string,
    (orgId: string, accountId: string) => (env: ScriptEnv) => Promise<void>,
  ][] = [
    [
      "an Agent dispatch (agents FOR SHARE)",
      (orgId) => async (env) => {
        await sql`SELECT id FROM capybara.agents WHERE org_id = ${orgId} ORDER BY id FOR SHARE`.execute(
          env.host.current() as NonNullable<ReturnType<TransactionHost["current"]>>,
        );
      },
    ],
    [
      "the first default device (org and membership FOR SHARE)",
      (orgId, accountId) => async (env) => {
        const t = env.host.current() as NonNullable<ReturnType<TransactionHost["current"]>>;
        await sql`SELECT id FROM capybara.orgs WHERE id = ${orgId} FOR SHARE`.execute(t);
        await sql`SELECT account_id FROM capybara.memberships
            WHERE org_id = ${orgId} AND account_id = ${accountId} FOR SHARE`.execute(t);
      },
    ],
  ];

  it.each(patterns)(
    "%s: offboarding waits for the step, no deadlock, the run is stopped",
    async (name, inside) => {
      const orgId = await createOrgWithProviders(kernelA(), req, `Offboard ${name.slice(0, 8)}`);
      const m = await member(orgId, "admin");
      const memberReq = await session(kernelA(), m.login);
      // the member's own agent and conversation: offboarding locks both
      const agentId = await createAgent(memberReq, orgId);
      const conv = await createConv(memberReq, orgId, agentId);
      const h = holdIn(conv, {
        admission: "exclusive",
        inside: inside(orgId, m.id),
        awaitAbort: true,
      });
      await postMessage(memberReq, orgId, conv, "hi");
      const pid = await within(h.pid, 15_000, "tool step held");
      const runId = await runIdOf(conv);
      const removal = track(
        req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${m.id}` }),
      );
      // offboarding waits at the org row, before the membership, agents and conversations
      await waitFor(
        () => blockedBy([pid], "orgs", "for no key update"),
        10_000,
        "offboarding waiting for the org row",
      );
      expect(removal.settled()).toBe(false);
      h.release();
      expect(await h.after).toBe("ok");
      const res = await within(removal.p, 10_000, "offboarding");
      expect(res.statusCode, res.body).toBe(204);
      await waitStatus(conv, runId, "aborted");
    },
  );
});

describe("conversation deletion during a run's hot-path write", () => {
  it("waits for the open transaction; the run's next write is refused", async () => {
    const { orgId, convs } = await orgWithConvs("Conv deletion", 1);
    const conv = convs[0] as string;
    const h = holdIn(conv, { admission: "shared", afterwards: checkpoint });
    await postMessage(req, orgId, conv, "hi");
    const pid = await within(h.pid, 15_000, "run held");
    const runId = await runIdOf(conv);
    const deletion = track(
      req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/conversations/${conv}` }),
    );
    // the deletion takes the root row FOR UPDATE: it waits for the run's transaction
    await waitFor(
      () => blockedBy([pid], "conversations", "for update"),
      10_000,
      "deletion waiting for the conversation row",
    );
    expect(deletion.settled()).toBe(false);
    h.release();
    const res = await within(deletion.p, 10_000, "deletion");
    expect(res.statusCode, res.body).toBe(204);
    expect(await h.after).toBe("execution revoked");
    await waitStatus(conv, runId, "aborted");
  });
});

describe("the admission guards", () => {
  it("an unauthorized deletion or removal is refused without waiting for admitted writes", async () => {
    const { orgId, convs } = await orgWithConvs("Precheck", 1);
    const h = holdIn(convs[0] as string, { admission: "shared" });
    await postMessage(req, orgId, convs[0] as string, "hi");
    await within(h.pid, 15_000, "run held");
    const admin = await member(orgId, "admin");
    const plain = await member(orgId);
    const plainReq = await session(kernelA(), plain.login);
    const adminReq = await session(kernelA(), admin.login);
    // org deletion needs an owner; a member removal an admin: 403 at once, the run still held
    const del = await within(
      adminReq({ method: "DELETE", url: `/api/v1/orgs/${orgId}` }),
      10_000,
      "refused deletion",
    );
    expect(del.statusCode, del.body).toBe(403);
    const rm = await within(
      plainReq({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${admin.id}` }),
      10_000,
      "refused removal",
    );
    expect(rm.statusCode, rm.body).toBe(403);
    h.release();
    expect(await h.after).toBe("ok");
  });

  it("a shared transaction takes no org-level lock; offboarding never runs in a fenced one", async () => {
    const { orgId, convs } = await orgWithConvs("Guards", 1);
    const conv = convs[0] as string;
    const outcomes: string[] = [];
    const attempt = async (p: () => Promise<unknown>) => {
      try {
        await p();
        outcomes.push("ok");
      } catch (e) {
        outcomes.push(e instanceof Error ? e.message : String(e));
      }
    };
    const done = gate();
    scripts.set(conv, async (env) => {
      const orgLock = env.get(OrgLock);
      await env.host.run(() => attempt(() => orgLock.lock(orgId)), { admission: "shared" });
      await env.host.run(() => attempt(() => env.get(XactLock).lock("guard-test")), {
        admission: "shared",
      });
      // the same lock in an exclusive (tool-step) transaction is fine
      await withExclusiveAdmission(() => env.host.run(() => attempt(() => orgLock.lock(orgId))));
      // org deletion's / offboarding's lock refuses any fenced transaction
      await env.host.run(() => attempt(() => orgLock.lockForRemoval(orgId)));
      // shared admission needs READ COMMITTED
      await attempt(() =>
        env.host.run(async () => {}, { admission: "shared", isolationLevel: "repeatable read" }),
      );
      done.open();
      return "completed";
    });
    await postMessage(req, orgId, conv, "hi");
    await within(done.promise, 15_000, "guard script");
    expect(outcomes[0]).toMatch(/the org lock inside a transaction the run fence admitted shared/);
    expect(outcomes[1]).toMatch(/advisory lock guard-test inside a transaction the run fence/);
    expect(outcomes[2]).toBe("ok");
    expect(outcomes[3]).toMatch(/never run inside a run's fenced transaction/);
    expect(outcomes[4]).toMatch(/needs READ COMMITTED/);
  });
});
