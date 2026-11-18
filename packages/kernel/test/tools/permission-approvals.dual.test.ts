import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { currentStore, TransactionHost } from "../../src/infra/database/transaction-host.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { RunExecution, withExclusiveAdmission } from "../../src/runtime/run-execution.js";
import { AGENT_LOOP_FACTORY, type AgentLoopFactory } from "../../src/runtime/run-steps.js";
import { RunWorker } from "../../src/runtime/run-worker.js";
import { Waits } from "../../src/runtime/waits.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import type { PermissionCandidate } from "../../src/sandbox/permission-call-types.js";
import { permissionCandidateHash } from "../../src/sandbox/review/permission-candidate.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { PermissionApprovalJobs } from "../../src/tools/permission-approval-jobs.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

let pg: TestContainer,
  rd: TestContainer,
  a: TestKernel,
  b: TestKernel,
  raw: ReturnType<typeof createDb>,
  redis: Redis,
  queue: Queue;
let deliver = false;
let active: Awaited<ReturnType<typeof permissionFixture>>;
const loop: AgentLoopFactory = () => ({
  run: async (ctx) => {
    // a tool step runs under exclusive admission, as the real loop runs it
    const result = await withExclusiveAdmission(() =>
      b.app.get(ToolPipeline).runStep({ ...active.ctx, signal: ctx.signal }),
    );
    return result.kind === "suspended" ? result : { kind: "completed", consumedUpToSeq: 1 };
  },
});
beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const config = KernelConfigSchema.parse({
    db: { url: pg.url, poolMax: 8 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    ...MODEL_PLUGINS_CONFIG,
  });
  a = await startKernel(config, {
    env: {},
    logger: createLogger("error", { write: () => {} }),
    overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => !deliver }],
  });
  b = await startKernel(config, {
    env: {},
    logger: createLogger("error", { write: () => {} }),
    overrides: [
      { provide: OUTBOX_DISPATCH_FAILS, useValue: () => !deliver },
      { provide: AGENT_LOOP_FACTORY, useValue: loop },
    ],
  });
  raw = createDb(pg.url, 8);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  queue = new Queue("cap-kernel-runs", { connection: redis });
});
afterAll(async () => {
  await queue?.close();
  redis?.disconnect();
  await b?.close();
  await a?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  deliver = false;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
  await redis.flushdb();
});
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function pending(profile: "request-approval" | "approve-for-me" = "request-approval") {
  const f = await permissionFixture(
    a,
    raw,
    "Write",
    { file_path: "/outside/reports/report.txt" },
    true,
  );
  active = f;
  f.install(b);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: profile })
    .where("id", "=", f.conversationId)
    .execute();
  const result = await a.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => a.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(result.kind).toBe("suspended");
  if (result.kind !== "suspended") throw new Error("Expected real pipeline wait");
  await a.app.get(Waits).suspend(f.runId, f.conversationId, result.waitingFor);
  const ask = (await a.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  return { ...f, ask };
}
async function runOwed(f: Awaited<ReturnType<typeof pending>>) {
  const run = await f.db
    .selectFrom("runs")
    .select("job_id")
    .where("id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect(run.job_id).toBeTruthy();
  deliver = true;
  await waitFor(
    async () => {
      await f.db
        .updateTable("outbox")
        .set({ next_attempt_at: sql`now()` })
        .where("job_name", "=", "run")
        .execute();
      await b.app.get(OutboxDispatcher).dispatchDue(500);
      return (
        (
          await f.db
            .selectFrom("outbox")
            .select("id")
            .where("job_name", "=", "run")
            .where("dead_at", "is", null)
            .execute()
        ).length === 0
      );
    },
    30000,
    "replica B delivers the committed run obligation",
  );
  const job = await queue.getJob(run.job_id!);
  expect(job).not.toBeUndefined();
  await b.app.get(RunWorker).process(job!, undefined);
  await b.app.get(RunWorker).process(job!, undefined);
}

it("human decision survives loss immediately after commit without profile change", async () => {
  const f = await pending();
  const service = a.app.get(PermissionCallGrants),
    issue = service.issueLocked.bind(service);
  vi.spyOn(service, "issueLocked").mockImplementation(async (...args) => {
    const grant = await issue(...args);
    const store = currentStore()!;
    store.hooks.length = 0;
    store.hooks.push = () => 0; // Lose every process continuation after the human transaction.
    return grant;
  });
  await a.app
    .get(ApprovalsService)
    .decide(f.orgId, f.ask.id, f.accountId, { decision: "approve", scope: "once" });
  expect(
    (await f.db.selectFrom("runs").select("status").where("id", "=", f.runId).executeTakeFirst())
      ?.status,
  ).toBe("queued");
  expect(
    await f.db.selectFrom("outbox").select("id").where("job_name", "=", "run").execute(),
  ).toHaveLength(1);
  expect(f.effects()).toBe(0);
  await runOwed(f);
  expect(f.effects()).toBe(1);
  expect(await f.db.selectFrom("permission_call_grants").select("id").execute()).toHaveLength(1);
  expect(
    await f.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("run_id", "=", f.runId)
      .where("type", "=", "tool_result")
      .execute(),
  ).toHaveLength(1);
});

it("profile writer wins before late click", async () => {
  const f = await pending(),
    entered = barrier(),
    release = barrier();
  const locks = a.app.get(PermissionAuthorityLock),
    acquire = locks.acquire.bind(locks);
  vi.spyOn(locks, "acquire").mockImplementation(async (subject, intent) => {
    entered.resolve();
    await release.promise;
    return acquire(subject, intent);
  });
  const click = a.app
    .get(ApprovalsService)
    .decide(f.orgId, f.ask.id, f.accountId, { decision: "approve", scope: "once" });
  const outcome = click.catch((e) => e);
  await entered.promise;
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "approve-for-me",
    expectedRevision: 0,
  });
  release.resolve();
  expect(await outcome).toMatchObject({ code: "approval.already_decided" });
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  expect(f.effects()).toBe(0);
});

it("click wins but resume sees newer profile", async () => {
  const f = await pending();
  await a.app
    .get(ApprovalsService)
    .decide(f.orgId, f.ask.id, f.accountId, { decision: "approve", scope: "once" });
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "request-approval",
    expectedRevision: 0,
  });
  await runOwed(f);
  expect(f.effects()).toBe(0);
  const asks = await f.db
    .selectFrom("approvals")
    .selectAll()
    .where("run_id", "=", f.runId)
    .orderBy("attempt")
    .execute();
  expect(asks.map((row) => row.status)).toEqual(["approved", "pending"]);
  if (!asks[1]) throw new Error("Missing current approval");
  expect(
    (asks[1].detail as { permissionCandidate: PermissionCandidate }).permissionCandidate.binding
      .profileRevision,
  ).toBe(1);
});

it("request insertion loses to supersession", async () => {
  const f = await permissionFixture(
      a,
      raw,
      "Write",
      { file_path: "/outside/reports/report.txt" },
      true,
    ),
    entered = barrier(),
    release = barrier();
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  const approvals = a.app.get(ApprovalsService),
    request = approvals.requestCommand.bind(approvals);
  vi.spyOn(approvals, "requestCommand").mockImplementation(async (input) => {
    entered.resolve();
    await release.promise;
    return request(input);
  });
  const running = a.app
    .get(RunExecution)
    .withClaim(
      f.claim,
      () => true,
      () => a.app.get(ToolPipeline).runStep(f.ctx),
    )
    .catch((e) => e);
  await entered.promise;
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "approve-for-me",
    expectedRevision: 0,
  });
  release.resolve();
  // the activated ask path fails closed: the superseded insertion refuses the call, not the run
  expect(await running).toMatchObject({ kind: "done" });
  expect(await f.db.selectFrom("approvals").selectAll().execute()).toEqual([]);
  expect(f.effects()).toBe(0);
  const [refused] = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "tool_result")
    .where("run_id", "=", f.runId)
    .execute();
  expect(refused?.payload).toMatchObject({
    isError: true,
    review: { decision: "deny", by: "rule" },
  });
  expect((refused?.payload as { content?: string } | undefined)?.content).toContain(
    "The permission check for this call could not be completed",
  );
});

it("two different grant issuances race for one exact binding on distinct PostgreSQL sessions", async () => {
  const f = await pending("approve-for-me"),
    candidate = f.ask.command?.permissionCandidate;
  if (!candidate) throw new Error("Missing permission candidate");
  const alternative = {
    ...candidate,
    permissionScope: {
      readDirectories: ["/outside/other"],
      writeDirectories: ["/outside/other"],
      hosts: [],
    },
  };
  const { candidateHash: _hash, ...body } = alternative;
  const other = { ...body, candidateHash: permissionCandidateHash(body) };
  const ready = barrier();
  let count = 0;
  const pids: number[] = [];
  async function issue(kernel: TestKernel, proposed: PermissionCandidate) {
    return kernel.app.get(TransactionHost).run(async () => {
      const db = kernel.app.get(KernelDb);
      await kernel.app
        .get(PermissionAuthorityLock)
        .acquire(
          { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
          { kind: "admit" },
        );
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db);
      if (!rows[0]) throw new Error("Missing PostgreSQL session");
      pids.push(rows[0].pid);
      if (++count === 2) ready.resolve();
      await ready.promise;
      const [event] = await kernel.app.get(EventLog).appendIn(f.conversationId, [
        {
          type: "permission_reviewed",
          runId: f.runId,
          payload: {
            ...proposed,
            outcome: "allow",
            reason: "Exact scope reviewed",
            decisionSource: "review-model",
          },
        },
      ]);
      if (!event) throw new Error("Missing real review event");
      const decision = {
        source: "review-model" as const,
        reviewEventSeq: event.seq,
        decidedBy: null,
      };
      const grant = await kernel.app.get(PermissionCallGrants).issueLocked(proposed, decision);
      expect(await kernel.app.get(PermissionCallGrants).issueLocked(proposed, decision)).toEqual(
        grant,
      );
      return grant;
    });
  }
  const result = await Promise.allSettled([issue(a, candidate), issue(b, other)]);
  expect(new Set(pids).size).toBe(2);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
  const rows = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  expect(rows).toHaveLength(1);
  for (const kernel of [a, b])
    await kernel.app.get(TransactionHost).run(async () => {
      await kernel.app
        .get(PermissionAuthorityLock)
        .acquire(
          { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
          { kind: "admit" },
        );
      expect(
        await kernel.app.get(PermissionCallGrants).findForAdmission(candidate.binding),
      ).toEqual({ id: rows[0]?.id, expansion: rows[0]?.expansion, source: rows[0]?.source });
    });
  await writeFile(
    "/tmp/capybara-task7-replica-provenance.json",
    JSON.stringify(
      {
        backendPids: pids,
        processId: process.pid,
        kernelContextsDistinct: a.app !== b.app,
        databaseProvidersDistinct: a.app.get(KernelDb) !== b.app.get(KernelDb),
        sharedDatabase: true,
        sharedRedis: true,
        fixture: "permission-approvals.dual.test.ts",
      },
      null,
      2,
    ),
  );
});

it("duplicate reordered recheck and lost response converge while a mandatory wait blocks execution", async () => {
  const f = await pending();
  await f.db
    .insertInto("approvals")
    .values({
      id: "mandatory",
      org_id: f.orgId,
      conversation_id: f.conversationId,
      run_id: f.runId,
      call_id: "mandatory-call",
      attempt: 1,
      tool_key: "mandatory",
      spec_hash: "spec",
      connector_id: null,
      requested_for: f.accountId,
      approver_role: null,
      scope: null,
      decided_by: null,
      expires_at: new Date(Date.now() + 3600000),
    })
    .execute();
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "approve-for-me",
    expectedRevision: 0,
  });
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "request-approval",
    expectedRevision: 1,
  });
  const data = { orgId: f.orgId, rootConversationId: f.conversationId };
  await b.app.get(PermissionApprovalJobs).recheck({ ...data, revision: 2 });
  await a.app.get(PermissionApprovalJobs).recheck({ ...data, revision: 1 });
  await b.app.get(PermissionApprovalJobs).recheck({ ...data, revision: 2 });
  expect(
    (await f.db.selectFrom("runs").select("status").where("id", "=", f.runId).executeTakeFirst())
      ?.status,
  ).toBe("waiting");
  expect(f.effects()).toBe(0);
  expect(
    (
      await f.db
        .selectFrom("approvals")
        .select("status")
        .where("id", "=", "mandatory")
        .executeTakeFirst()
    )?.status,
  ).toBe("pending");
  await a.app.get(ApprovalsService).decide(f.orgId, "mandatory", f.accountId, {
    decision: "deny",
    reason: "Mandatory control settled",
  });
  await runOwed(f);
  const current = (await b.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  expect(current.status).toBe("pending");
  expect(current.command?.permissionCandidate?.binding.profileRevision).toBe(2);
  await b.app
    .get(ApprovalsService)
    .decide(f.orgId, current.id, f.accountId, { decision: "approve", scope: "once" });
  await runOwed(f);
  await a.app.get(PermissionApprovalJobs).recheck({ ...data, revision: 1 });
  await b.app.get(PermissionApprovalJobs).recheck({ ...data, revision: 2 });
  expect(f.effects()).toBe(1);
  expect(
    await f.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("run_id", "=", f.runId)
      .where("type", "=", "tool_result")
      .execute(),
  ).toHaveLength(1);
});

import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { PermissionConfigPublication } from "../../src/sandbox/permission-config-publication.js";
import { PermissionInstanceWrites } from "../../src/sandbox/permission-instance-writes.js";

it.each(["instance", "selective-publication", "general-publication"] as const)(
  "automatic ceiling reset uses canonical transition through actual %s caller with a live inherited fence",
  async (writer) => {
    const f = await pending();
    const unboundId = randomUUID(),
      unaffectedId = randomUUID();
    if (writer === "general-publication") {
      for (const [id, profile] of [
        [unboundId, "full-access"],
        [unaffectedId, "approve-for-me"],
      ] as const)
        await f.db
          .insertInto("conversations")
          .values({
            id,
            org_id: f.orgId,
            agent_id: f.agentId,
            account_id: f.accountId,
            title: null,
            last_seq: 0,
            consumed_seq: 0,
            created_at: new Date(),
            updated_at: new Date(),
            source: "web",
            permission_profile: profile,
          })
          .execute();
    }
    const childId = randomUUID(),
      childRunId = randomUUID();
    await f.db
      .insertInto("conversations")
      .values({
        id: childId,
        org_id: f.orgId,
        agent_id: f.agentId,
        account_id: f.accountId,
        title: null,
        last_seq: 0,
        consumed_seq: 0,
        created_at: new Date(),
        updated_at: new Date(),
        kind: "subagent",
        source: "subagent",
        parent_conversation_id: f.conversationId,
      })
      .execute();
    await f.db
      .insertInto("runs")
      .values({
        id: childRunId,
        conversation_id: childId,
        status: "waiting",
        agent_version: 1,
        trigger_account_id: f.accountId,
        trigger_seq: 0,
      })
      .execute();
    const childAsk = await a.app.get(ApprovalsService).requestCommand({
      orgId: f.orgId,
      conversationId: childId,
      runId: childRunId,
      callId: "child",
      step: 1,
      requestedFor: f.accountId,
      scopes: ["once"],
      detail: {
        deviceId: f.deviceId,
        deviceName: "Laptop",
        mode: "auto",
        kind: "command",
        command: "python generated.py",
        rule: null,
        reason: "Requires review",
      },
    });
    await f.db
      .updateTable("conversations")
      .set({
        permission_profile: "full-access",
        permission_consent: JSON.stringify({
          deviceId: f.deviceId,
          scopeRevision: (
            await a.app.get(PermissionProfilesService).get(f.orgId, f.conversationId, f.accountId)
          ).scopeRevision,
        }),
      })
      .where("id", "=", f.conversationId)
      .execute();
    if (writer === "selective-publication")
      await f.db
        .updateTable("devices")
        .set({ source: "cloud" })
        .where("id", "=", f.deviceId)
        .execute();
    const entered = barrier(),
      release = barrier(),
      readerEntered = barrier();
    const log = b.app.get(EventLog),
      append = log.appendIn.bind(log);
    vi.spyOn(log, "appendIn").mockImplementation(async (...args) => {
      if (args[1].some((event) => event.type === "permission_profile_changed")) {
        entered.resolve();
        await release.promise;
      }
      return append(...args);
    });
    const config = b.app.get(KernelConfigService).get();
    const next = structuredClone(config);
    if (writer === "general-publication") next.devices.fullAccess = "off";
    if (writer === "selective-publication")
      next.sandbox.limits.egress = config.sandbox.limits.egress === "none" ? "allowlist" : "none";
    const writing =
      writer === "instance"
        ? b.app
            .get(PermissionInstanceWrites)
            .commitHandle(
              f.orgId,
              f.deviceId,
              0,
              { ...DEFAULT_SANDBOX_ROOTS, workspace: "/changed" },
              {},
              new AbortController().signal,
            )
        : b.app.get(PermissionConfigPublication).publish(config, next);
    await entered.promise;
    const locks = a.app.get(PermissionAuthorityLock),
      acquire = locks.acquire.bind(locks);
    vi.spyOn(locks, "acquire").mockImplementation(async (...args) => {
      readerEntered.resolve();
      return acquire(...args);
    });
    // A live inherited claim must wait on authority before acquiring its conversation row.
    const reading = a.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () =>
        a.app
          .get(PermissionApprovalJobs)
          .recheck({ orgId: f.orgId, rootConversationId: f.conversationId, revision: 1 }),
    );
    await readerEntered.promise;
    release.resolve();
    await writing;
    await reading;
    const root = await f.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", f.conversationId)
      .executeTakeFirstOrThrow();
    expect(root.permission_profile).toBe("approve-for-me");
    expect(root.permission_revision).toBe(1);
    const child = await f.db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", childAsk.id)
      .executeTakeFirstOrThrow();
    expect(child).toMatchObject({
      status: "superseded",
      superseded_revision: 1,
      scope: null,
      decided_by: null,
    });
    const changes = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", f.conversationId)
      .where("type", "=", "permission_profile_changed")
      .execute();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({
      actorAccountId: null,
      scopeRevision: null,
      reason: "authority-changed",
      revision: 1,
    });
    const audits = await f.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "conversation.permission_profile_changed")
      .execute();
    expect(audits).toHaveLength(writer === "general-publication" ? 2 : 1);
    if (writer === "general-publication") {
      const unbound = await f.db
        .selectFrom("conversation_events")
        .select("payload")
        .where("conversation_id", "=", unboundId)
        .where("type", "=", "permission_profile_changed")
        .executeTakeFirstOrThrow();
      expect(unbound.payload).toMatchObject({
        deviceId: null,
        scopeRevision: null,
        actorAccountId: null,
        revision: 1,
      });
      expect(
        (
          await f.db
            .selectFrom("conversations")
            .select("permission_revision")
            .where("id", "=", unaffectedId)
            .executeTakeFirstOrThrow()
        ).permission_revision,
      ).toBe(0);
    }
    expect(audits[0]?.detail).toMatchObject({
      writer: { level: writer === "instance" ? "device" : "platform" },
    });
    // Restore publication through its actual CAS path so the next fixture starts at the app config.
    if (writer !== "instance") {
      vi.restoreAllMocks();
      await b.app.get(PermissionConfigPublication).publish(next, config);
    }
  },
);

it("profile writer versus inherited claim fence refuses replaced and cancelled workers", async () => {
  const f = await permissionFixture(a, raw, "Read", { file_path: "/work/a" }, true),
    entered = barrier(),
    release = barrier();
  const locks = a.app.get(PermissionAuthorityLock),
    acquire = locks.acquire.bind(locks);
  vi.spyOn(locks, "acquire").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return acquire(...args);
  });
  let live = true;
  const running = a.app
    .get(RunExecution)
    .withClaim(
      f.claim,
      () => live,
      () => a.app.get(ToolPipeline).runStep(f.ctx),
    )
    .catch((e) => e);
  await entered.promise;
  await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "request-approval",
    expectedRevision: 0,
  });
  // another execution takes the run on replica b. The paused prelude runs inside the fence after
  // its org row, so b's RunExecution.claim (which locks the org row too) would wait for it; the
  // replaced execution id is what a's fence then compares
  const replaced = await f.db
    .updateTable("runs")
    .set({ execution_id: randomUUID() })
    .where("id", "=", f.runId)
    .where("execution_id", "=", f.claim.executionId)
    .executeTakeFirst();
  expect(replaced.numUpdatedRows).toBe(1n);
  live = false;
  release.resolve();
  expect(await running).toMatchObject({ message: "execution revoked" });
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
});

import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { buildPermissionCandidate } from "../../src/sandbox/review/permission-candidate.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";

it("system reset reaches scheduled child without lending interactive call authority", async () => {
  const f = await pending();
  const parentCandidate = f.ask.command?.permissionCandidate;
  if (!parentCandidate) throw new Error("Missing parent permission candidate");
  await a.app
    .get(ApprovalsService)
    .decide(f.orgId, f.ask.id, f.accountId, { decision: "approve", scope: "once" });
  const childId = randomUUID(),
    childRunId = randomUUID(),
    taskId = randomUUID(),
    taskRunId = randomUUID();
  await f.db
    .insertInto("conversations")
    .values({
      id: childId,
      org_id: f.orgId,
      agent_id: f.agentId,
      account_id: f.accountId,
      title: null,
      last_seq: 0,
      consumed_seq: 0,
      created_at: new Date(),
      updated_at: new Date(),
      kind: "subagent",
      source: "subagent",
      parent_conversation_id: f.conversationId,
    })
    .execute();
  const store = new ScheduledTaskStore();
  await store.insertTask(f.db, {
    id: taskId,
    orgId: f.orgId,
    accountId: f.accountId,
    agentId: f.agentId,
    name: "Owned task",
    prompt: "Write report",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
    mode: "conversation",
    conversationId: f.conversationId,
    chat: null,
    model: null,
    effort: null,
    deviceId: f.deviceId,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
  });
  await store.insertRun(f.db, {
    id: taskRunId,
    taskId,
    orgId: f.orgId,
    scheduledFor: new Date(),
    trial: false,
    status: "running",
  });
  await f.db
    .insertInto("runs")
    .values({
      id: childRunId,
      conversation_id: childId,
      status: "waiting",
      agent_version: 1,
      trigger_account_id: f.accountId,
      trigger_seq: 0,
      scheduled_task_run_id: taskRunId,
    })
    .execute();
  const input = { file_path: "/outside/reports/report.txt" };
  await a.app.get(EventLog).append(childId, [
    {
      type: "assistant_message",
      runId: childRunId,
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: "child", name: "Write", input }],
      },
    },
  ]);
  const childAsk = await a.app.get(ApprovalsService).requestCommand({
    orgId: f.orgId,
    conversationId: childId,
    runId: childRunId,
    callId: "child",
    step: 1,
    requestedFor: f.accountId,
    scopes: ["once"],
    detail: {
      deviceId: f.deviceId,
      deviceName: "Laptop",
      mode: "auto",
      kind: "command",
      command: "python generated.py",
      rule: null,
      reason: "Existing discretionary wait",
    },
  });
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "full-access" })
    .where("id", "=", f.conversationId)
    .execute();
  await b.app
    .get(PermissionInstanceWrites)
    .commitHandle(
      f.orgId,
      f.deviceId,
      0,
      { ...DEFAULT_SANDBOX_ROOTS, workspace: "/changed" },
      {},
      new AbortController().signal,
    );
  expect(
    (
      await f.db
        .selectFrom("approvals")
        .select("status")
        .where("id", "=", childAsk.id)
        .executeTakeFirst()
    )?.status,
  ).toBe("superseded");
  const snapshot = await b.app.get(SandboxOperationAuthority).previewCall(
    {
      orgId: f.orgId,
      deviceId: f.deviceId,
      holderConversationId: childId,
      actor: { accountId: f.accountId, conversationId: childId, runId: childRunId },
    },
    { runId: childRunId, callId: "child" },
    new AbortController().signal,
  );
  expect(snapshot).toMatchObject({
    unattended: true,
    profile: "request-approval",
    rootConversationId: f.conversationId,
    profileRevision: 1,
  });
  const built = buildPermissionCandidate(
    { toolKey: "Write", specHash: "child-spec", rawInput: input, validatedInput: input },
    snapshot,
  );
  if (built.kind !== "proposal") throw new Error("Expected explicit proposal");
  await b.app.get(TransactionHost).run(async () => {
    await b.app
      .get(PermissionAuthorityLock)
      .acquire(
        { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
        { kind: "admit" },
      );
    const grants = b.app.get(PermissionCallGrants);
    expect(
      await grants.findForAdmission({
        ...parentCandidate.binding,
        conversationId: childId,
        runId: childRunId,
        callId: "child",
      }),
    ).toBeNull();
    await expect(
      grants.issueLocked(built.candidate, {
        source: "review-model",
        reviewEventSeq: 1,
        decidedBy: null,
      }),
    ).rejects.toThrow("unattended");
  });
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toHaveLength(1);
  expect(f.effects()).toBe(0);
});

it.each(["request-approval", "approve-for-me", "full-access"] as const)(
  "terminal human refusal survives %s revision before replica resume",
  async (profile) => {
    const f = await pending();
    await a.app.get(ApprovalsService).decide(f.orgId, f.ask.id, f.accountId, {
      decision: "deny",
      reason: "Do not grant this directory.",
    });
    const view = await b.app
      .get(PermissionProfilesService)
      .get(f.orgId, f.conversationId, f.accountId);
    await b.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile,
      expectedRevision: view.revision,
      ...(profile === "full-access"
        ? { consentScopeRevision: view.scopeRevision ?? undefined }
        : {}),
    });
    await runOwed(f);
    expect(f.effects()).toBe(0);
    expect(
      await f.db
        .selectFrom("permission_call_grants")
        .selectAll()
        .where("run_id", "=", f.runId)
        .execute(),
    ).toEqual([]);
    const cards = await f.db
      .selectFrom("approvals")
      .select(["id", "status"])
      .where("run_id", "=", f.runId)
      .where("call_id", "=", f.callId)
      .execute();
    expect(cards).toEqual([{ id: f.ask.id, status: "denied" }]);
    const result = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("run_id", "=", f.runId)
      .where("type", "=", "tool_result")
      .executeTakeFirstOrThrow();
    expect(result.payload).toMatchObject({
      isError: true,
      review: { decision: "deny", by: "person" },
    });
  },
);
