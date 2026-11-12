import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { subagentsWaitId } from "../../src/runtime/loop.js";
import { processDeliverToParent, processStopTree } from "../../src/runtime/subagents/tree-jobs.js";
import { Waits } from "../../src/runtime/waits.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The bodies of the jobs a run's end owes for its sub-agent tree (transactional outbox spec §6;
 * they replaced the wait sweep's sub-agent passes): `stop-tree` (a finished run stops only its
 * fork child, agent map spec §5.4), `deliver-to-parent` (a background child's finish, delivered
 * once) and the fork invocation's
 * `wait-timeout` (`Waits.expire`: its child stops as `timed_out`). Rows are written by hand: a
 * parent run, one child conversation and run, and the dispatch row between them.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let req: Req;
let orgId: string;
let ownerId: string;
let agentId: string;

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  req = await session(k, "owner");
  orgId = await createOrg(req);
  agentId = await createAgent(req, orgId);
});

async function runStatus(runId: string): Promise<string> {
  const r = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return r.status;
}

/**
 * A parent run of a new conversation in `status`, one child conversation whose run is `running`
 * and the dispatch row between them (a fork invocation's with `forSkill`).
 */
async function dispatched(
  status: "completed" | "waiting",
  forSkill: boolean,
): Promise<{ convId: string; runId: string; childConv: string; childRun: string }> {
  const convId = await createConv(req, orgId, agentId);
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status,
      agent_version: 1,
      trigger_account_id: ownerId,
      trigger_seq: 0,
      ...(status === "waiting"
        ? {
            waiting_since: sql<Date>`now() - interval '5 minutes'`,
            wait_expires_at: sql<Date>`now() - interval '1 minute'`,
          }
        : { finished_at: sql<Date>`now() - interval '5 minutes'` }),
    })
    .execute();
  const childConv = randomUUID();
  await db
    .insertInto("conversations")
    .values({
      id: childConv,
      org_id: orgId,
      agent_id: agentId,
      account_id: ownerId,
      title: "Child",
      kind: "subagent",
      parent_conversation_id: convId,
      subagent_type: "general-purpose",
      subagent_depth: 1,
    })
    .execute();
  const childRun = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: childRun,
      conversation_id: childConv,
      status: "running",
      agent_version: 1,
      trigger_account_id: ownerId,
      trigger_seq: 0,
      budget_run_id: runId,
    })
    .execute();
  await db
    .insertInto("subagent_dispatches")
    .values({
      parent_run_id: runId,
      parent_call_id: forSkill ? "skill-1" : "call-1",
      parent_conversation_id: convId,
      step: forSkill ? 0 : 1,
      child_conversation_id: childConv,
      child_run_id: childRun,
      resumed: false,
      budget_run_id: runId,
      for_skill: forSkill,
    })
    .execute();
  return { convId, runId, childConv, childRun };
}

describe("the sub-agent jobs a run's end owes (agent map spec §5.4)", () => {
  it("a finished parent run's stop-tree job leaves its active background child alone", async () => {
    const d = await dispatched("completed", false);
    await processStopTree(k.app.get(Waits), { runId: d.runId });
    expect(await runStatus(d.childRun)).toBe("running");
    expect(ofType(await eventsOf(db, d.childConv), "run_aborted")).toEqual([]);
  });

  it("deliver-to-parent delivers a background child's finish its finisher never wrote, once", async () => {
    const d = await dispatched("completed", false);
    await k.app.get(EventLog).append(d.childConv, [
      {
        type: "run_finished",
        runId: d.childRun,
        payload: { reason: "completed", consumedUpToSeq: 0 },
      },
    ]);
    await db
      .updateTable("runs")
      .set({ status: "completed", finished_at: sql<Date>`now() - interval '5 minutes'` })
      .where("id", "=", d.childRun)
      .execute();
    // the finisher died after the child's terminal commit: the job that commit owed delivers it
    await processDeliverToParent(k.app.get(Waits), { childRunId: d.childRun });
    expect(ofType(await eventsOf(db, d.convId), "subagent_delivery")).toHaveLength(1);
    expect(ofType(await eventsOf(db, d.convId), "subagent_finished")).toHaveLength(1);
    // a second run of the job (a redelivery) writes nothing more
    await processDeliverToParent(k.app.get(Waits), { childRunId: d.childRun });
    expect(ofType(await eventsOf(db, d.convId), "subagent_delivery")).toHaveLength(1);
  });

  it("a fork dispatch's wait timeout stops its child as timed_out", async () => {
    const d = await dispatched("waiting", true);
    const r = await k.app
      .get(Waits)
      .expire("subagents", subagentsWaitId(d.runId, 0), { runId: d.runId, step: 0 });
    expect(r.acted).toBe(true);
    expect(await runStatus(d.childRun)).toBe("aborted");
    const aborted = ofType(await eventsOf(db, d.childConv), "run_aborted");
    expect(aborted.map((e) => e.payload.detail)).toEqual(["wait_timeout"]);
    const finished = ofType(await eventsOf(db, d.convId), "subagent_finished");
    expect(finished.map((e) => e.payload.status)).toEqual(["timed_out"]);
    // a fork's child is never delivered: its waiting run writes the report itself
    expect(ofType(await eventsOf(db, d.convId), "subagent_delivery")).toEqual([]);
  });
});
