import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type ExtensionContext,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { conversationTopic, EventLog } from "../../src/conversations/event-log.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { createLogger } from "../../src/log.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { SCOPE_DENIED_TOOL_TEXT } from "../../src/tools/builtins/sandbox/common.js";
import { permissionCheckFailedText, ToolPipeline } from "../../src/tools/pipeline.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    {
      overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => true }],
      env: {},
      logger: createLogger("error", { write: () => {} }),
    },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
});

const fixture = (
  toolKey = "Read",
  input: Record<string, unknown> = { file_path: "/work/a" },
  staged = false,
) => permissionFixture(k, raw, toolKey, input, staged);

it("actual pipeline started event admits staged native operation", async () => {
  const f = await fixture();
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  const events = await f.db
    .selectFrom("conversation_events")
    .selectAll()
    .where("conversation_id", "=", f.conversationId)
    .orderBy("seq")
    .execute();
  expect(events.find((e) => e.type === "tool_call_started")?.payload).toMatchObject({
    callId: f.callId,
    toolKey: "Read",
  });
  const result = events.find((e) => e.type === "tool_result")?.payload;
  expect(
    result,
    JSON.stringify({ result, failures: f.failures.map((e) => String(e)) }),
  ).toMatchObject({ isError: false });
  const rows = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.runId)
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    call_id: f.callId,
    ordinal: 0,
    method: "stat",
    state: "completed",
  });
  expect(f.effects()).toBe(1);
});

import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";

import { ApprovalsService } from "../../src/tools/approvals.service.js";

it.each(["Write", "Edit"])(
  "actual bare %s asks for the exact parent directory before start",
  async (tool) => {
    const f = await fixture(tool, { file_path: "/outside/reports/report.txt" }, true);
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: "request-approval" })
      .where("id", "=", f.conversationId)
      .execute();
    const result = await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    expect(result.kind).toBe("suspended");
    const approval = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
    expect(approval?.command).toMatchObject({
      permissionScope: {
        readDirectories: ["/outside/reports"],
        writeDirectories: ["/outside/reports"],
        hosts: [],
      },
      targetPath: "/outside/reports/report.txt",
    });
    expect(f.effects()).toBe(0);
  },
);
it.each(["request-approval", "approve-for-me"] as const)(
  "inline project Python is a discretionary review in %s on the staged route (no review model: an ask)",
  async (profile) => {
    const f = await fixture("Bash", { command: "python -c 'import os; print(os.getcwd())'" }, true);
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: profile })
      .where("id", "=", f.conversationId)
      .execute();
    const result = await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    expect(result.kind).toBe("suspended");
    expect(f.effects()).toBe(0);
    const ask = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
    expect(ask?.status).toBe("pending");
    // the consent ask proposes no reach: approved, the call would run under the base scope
    expect(ask?.command?.permissionCandidate).toBeUndefined();
  },
);

it.each(["Write", "Edit"])(
  "human %s directory decision reaches the same actual call and all method scopes",
  async (tool) => {
    const f = await fixture(tool, { file_path: "/outside/reports/report.txt" }, true);
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: "request-approval" })
      .where("id", "=", f.conversationId)
      .execute();
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    const approval = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
    await k.app
      .get(ApprovalsService)
      .decide(f.orgId, approval.id, f.accountId, { decision: "approve", scope: "once" });
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    expect(f.effects()).toBe(1);
    expect(f.scopes[0]?.filesystem).toEqual({
      kind: "scoped",
      readRoots: ["/outside/reports", "/skills", "/work"],
      writeRoots: ["/outside/reports", "/work"],
    });
    const [grant] = await f.db.selectFrom("permission_call_grants").selectAll().execute();
    const [intent] = await f.db.selectFrom("sandbox_operation_intents").selectAll().execute();
    expect(grant?.expansion).toEqual(approval.command?.permissionScope);
    expect(intent?.permission_grant_id).toBe(grant?.id);
    expect(intent?.granted_hosts).toEqual([]);
  },
);

it("the activated ask path fails closed: a refused evidence or ask is a deny result, not a run error", async () => {
  const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  // the ask cannot be created (a conflicting card): the call is refused, the run goes on
  const request = vi
    .spyOn(k.app.get(ApprovalsService), "requestCommand")
    .mockRejectedValueOnce(new ApiError("conflict", "The call already has another card"));
  const result = await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  request.mockRestore();
  expect(result.kind).toBe("done");
  expect(f.effects()).toBe(0);
  const [refused] = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "tool_result")
    .where("run_id", "=", f.runId)
    .execute();
  const payload = refused?.payload as { isError?: boolean; content?: string; review?: unknown };
  expect(payload.isError).toBe(true);
  expect(payload.content).toBe(permissionCheckFailedText("The call already has another card"));
  expect(payload.review).toMatchObject({ decision: "deny", by: "rule" });
});

it("a reused grant records its real source: the person's approval", async () => {
  const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  // the exact call already holds a human grant when it is reviewed (the review's lookup)
  vi.spyOn(k.app.get(PermissionCallGrants), "findForAdmission").mockResolvedValueOnce({
    id: randomUUID(),
    expansion: {
      readDirectories: ["/outside/reports"],
      writeDirectories: ["/outside/reports"],
      hosts: [],
    },
    source: "human",
  });
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  const [result] = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "tool_result")
    .where("run_id", "=", f.runId)
    .execute();
  expect((result?.payload as { review?: unknown } | undefined)?.review).toMatchObject({
    decision: "allow",
    by: "person",
    decisionSource: "human",
  });
});

import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";

it("root change atomically supersedes pending discretionary cards and owes recheck", async () => {
  const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  const approval = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "approve-for-me",
    expectedRevision: 0,
  });
  expect((await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))?.status).toBe(
    "superseded",
  );
  expect(
    await f.db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", "permission-approval-recheck")
      .execute(),
  ).toEqual([{ job_id: `permission-recheck-${f.conversationId}-1` }]);
  await expect(
    k.app
      .get(ApprovalsService)
      .decide(f.orgId, approval.id, f.accountId, { decision: "approve", scope: "once" }),
  ).rejects.toMatchObject({ code: "approval.already_decided" });
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
});

import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";

it("same pending ID refreshes only before effect", async () => {
  const f = await fixture("Read", { file_path: "/work/a" }, true);
  const intents = k.app.get(SandboxOperationIntents),
    pending = intents.pending.bind(intents),
    ids: string[] = [];
  vi.spyOn(intents, "pending").mockImplementation(async (...args) => {
    const row = await pending(...args);
    ids.push(row.operation_id);
    if (ids.length === 1)
      await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
        profile: "request-approval",
        expectedRevision: 0,
      });
    return row;
  });
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(f.effects()).toBe(1);
  expect(f.scopes[0]?.profile).toBe("request-approval");
});
it("expired and stale pending invocation refuses before refresh", async () => {
  const f = await fixture("Read", { file_path: "/work/a" }, true);
  const intents = k.app.get(SandboxOperationIntents),
    pending = intents.pending.bind(intents);
  const calls = vi.spyOn(intents, "pending").mockImplementation(async (...args) => {
    const row = await pending(...args);
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({ deadline: new Date(0) })
      .where("operation_id", "=", row.operation_id)
      .execute();
    await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile: "request-approval",
      expectedRevision: 0,
    });
    return row;
  });
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(calls).toHaveBeenCalledTimes(1);
  expect(f.effects()).toBe(0);
  // the model gets the fixed scope text; the refusal's own reason is only logged
  expect(f.failures.map((e) => (e as Error).message)).toEqual([SCOPE_DENIED_TOOL_TEXT]);
  expect(f.warned.map(String).join(" ")).toContain("deadline elapsed");
});
it("legacy production route cannot skip review", async () => {
  const f = await fixture("Bash", { command: "python -c 'print(123)'" });
  const preview = await k.app
    .get(PermissionProfilesService)
    .get(f.orgId, f.conversationId, f.accountId);
  await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "full-access",
    consentScopeRevision: preview.scopeRevision!,
    expectedRevision: 0,
  });
  const result = await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(result.kind).toBe("suspended");
  expect(f.effects()).toBe(0);
});

import { LocalDeviceProvider } from "../../src/local-devices/local-device-provider.js";

it.each(["full-access", "request-approval"] as const)(
  "native read/write retain canonical %s scope without an exec grant",
  async (profile) => {
    const f = await fixture("Write", { file_path: "/work/a" }, true);
    const view = await k.app
      .get(PermissionProfilesService)
      .get(f.orgId, f.conversationId, f.accountId);
    await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile,
      expectedRevision: 0,
      ...(profile === "full-access" ? { consentScopeRevision: view.scopeRevision! } : {}),
    });
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    const scope = f.scopes[0]!;
    expect(scope.network).toEqual({ kind: profile === "full-access" ? "environment" : "none" });
    expect(scope.filesystem.kind).toBe(profile === "full-access" ? "device" : "scoped");
    const forExecution = vi.spyOn(k.app.get(PermissionCallGrants), "forExecution");
    const sent: Record<string, unknown>[] = [];
    const adapter = k.app.get(LocalDeviceProvider).stagedOperations({
      call: async (_id, op, args) => {
        sent.push(args);
        return op === "readFile" ? { dataB64: "YQ==", truncated: false } : null;
      },
      permissionSupport: async () => ({
        version: 1,
        restricted: null,
        fullAccess: false,
        background: false,
      }),
    });
    const operation = await adapter.operation({ id: f.deviceId }, scope, f.ctx.signal);
    await operation.readFile("/work/a", { maxBytes: 1, signal: f.ctx.signal });
    await operation.writeFile("/work/a", new Uint8Array([1]), f.ctx.signal);
    expect(forExecution).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    for (const envelope of sent) {
      expect(envelope.scope).toEqual(scope);
      expect(envelope.grants).toBeUndefined();
      expect(envelope.limits).toBeUndefined();
    }
  },
);

import { CommandReviewService } from "../../src/sandbox/review/review.service.js";

it.each(["allow", "ask", "deny"] as const)(
  "independent reviewer %s cannot replace the actual candidate authority",
  async (decision) => {
    const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
    let candidate: unknown;
    vi.spyOn(k.app.get(CommandReviewService), "review").mockImplementation(async (input) => {
      candidate = input.permissionCandidate;
      // Even a compromised adapter's extra output cannot replace the candidate.
      return {
        decision,
        by: "classifier",
        reason: "Exact directory considered",
        rule: null,
        permissionScope: { writeDirectories: ["/"] },
      };
    });
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    const events = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("type", "=", "permission_reviewed")
      .where("run_id", "=", f.runId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ ...(candidate as object), outcome: decision });
    const grants = await f.db.selectFrom("permission_call_grants").selectAll().execute();
    expect(grants).toHaveLength(decision === "allow" ? 1 : 0);
    if (decision === "allow") {
      expect(grants[0]?.expansion).toEqual(
        (candidate as { permissionScope: unknown }).permissionScope,
      );
      expect(f.effects()).toBe(1);
    } else {
      expect(f.effects()).toBe(0);
      if (decision === "ask") {
        const ask = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
        expect(ask.command?.permissionCandidate).toEqual(candidate);
        await k.app
          .get(ApprovalsService)
          .decide(f.orgId, ask.id, f.accountId, { decision: "approve", scope: "once" });
        await k.app.get(RunExecution).withClaim(
          f.claim,
          () => true,
          () => k.app.get(ToolPipeline).runStep(f.ctx),
        );
        expect(f.effects()).toBe(1);
      }
    }
  },
);

// The recorded review names who decided: the review model only for its own verdicts; a fixed
// rule's deny, a rule ask (the review model unmapped) and the fail-closed ask are the rules'.
it.each([
  ["allow", "classifier", "review-model"],
  ["ask", "classifier", "review-model"],
  ["deny", "classifier", "review-model"],
  ["ask", "rule", "rule"],
  ["deny", "rule", "rule"],
] as const)(
  "a reviewed candidate's %s by %s records decision source %s",
  async (decision, by, source) => {
    const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
    vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
      decision,
      by,
      reason: "Reviewed",
      rule: by === "rule" ? "fixed.rule" : null,
    });
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    const events = await f.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("type", "=", "permission_reviewed")
      .where("run_id", "=", f.runId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ outcome: decision, decisionSource: source });
  },
);

it("owner refuses a directory proposal for file-only intent without lending parent authority", async () => {
  const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  const run = () =>
    k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
  await run();
  const ask = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  expect(ask.command?.permissionScope?.writeDirectories).toEqual(["/outside/reports"]);
  await k.app.get(ApprovalsService).decide(f.orgId, ask.id, f.accountId, {
    decision: "deny",
    reason: "Only the target file was intended; I do not approve its directory.",
  });
  await run();
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
});
it("explicit operation hosts reach only the matching admitted exec envelope", async () => {
  const f = await fixture("Bash", { command: "curl https://registry.npmjs.org/data" }, true);
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "classifier",
    rule: null,
    reason: "Exact host approved",
  });
  const sent: Record<string, unknown>[] = [];
  const adapter = k.app.get(LocalDeviceProvider).stagedOperations({
    call: async (_id, _op, args) => {
      sent.push(args);
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
    },
    permissionSupport: async () => ({
      version: 1,
      restricted: null,
      fullAccess: false,
      background: false,
    }),
  });
  f.setEffectHook(async (scope, method) => {
    expect(method).toBe("exec");
    const exec = async (actual: SandboxOperationScope) =>
      (await adapter.operation({ id: f.deviceId }, actual, f.ctx.signal)).exec({
        command: "curl https://registry.npmjs.org/data",
        cwd: "/work",
        timeoutMs: 1000,
        maxOutputBytes: 100,
        signal: f.ctx.signal,
      });
    await exec(scope);
    await expect(
      exec({
        ...scope,
        operationId: randomUUID(),
        network: { kind: "allowlist", hosts: ["registry.npmjs.org"] },
      }),
    ).rejects.toThrow("no current admitted execution identity");
    expect(
      await f.db.selectFrom("approvals").selectAll().where("kind", "=", "network").execute(),
    ).toEqual([]);
  });
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(f.failures).toEqual([]);
  expect(f.effects()).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.grants).toEqual({
    hosts: ["registry.npmjs.org"],
    source: { kind: "run", id: f.runId, accountId: f.accountId },
  });
  const ledger = await f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect(ledger.permission_grant_id).toBeTruthy();
  expect(ledger.granted_hosts).toEqual(["registry.npmjs.org"]);
});

it.each([false, true])(
  "stat read write use only their current call grant; change after first effect=%s",
  async (change) => {
    const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
    f.setNativeMethods(["stat", "readFile", "writeFile"]);
    vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
      decision: "allow",
      by: "classifier",
      rule: null,
      reason: "Exact directory approved",
    });
    if (change)
      f.setEffectHook(async (_scope, method) => {
        if (method === "stat")
          await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
            profile: "request-approval",
            expectedRevision: 0,
          });
      });
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    expect(f.effects()).toBe(change ? 1 : 3);
    const ledger = await f.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("run_id", "=", f.runId)
      .orderBy("ordinal")
      .execute();
    expect(ledger[0]?.permission_grant_id).toBeTruthy();
    if (change) {
      expect(ledger[1]?.permission_grant_id).toBeNull();
      expect(f.failures).toHaveLength(1);
      expect(f.scopes[0]?.profileRevision).toBe(0); // The admitted stat keeps its starting scope.
      expect(f.scopes[1]?.profileRevision).toBe(1);
    } else {
      expect(ledger.map((row) => row.method)).toEqual(["stat", "readFile", "writeFile"]);
      expect(new Set(ledger.map((row) => row.permission_grant_id)).size).toBe(1);
    }
  },
);

it("transition rollback preserves revision, pending decision, audit and outbox", async () => {
  const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
  await f.db
    .updateTable("conversations")
    .set({ permission_profile: "request-approval" })
    .where("id", "=", f.conversationId)
    .execute();
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  const events = k.app.get(EventLog),
    append = events.appendIn.bind(events);
  vi.spyOn(events, "appendIn").mockImplementation(async (...args) => {
    const result = await append(...args);
    if (
      args[1].some(
        (event) =>
          event.type === "approval_decided" &&
          (event.payload as { decision?: string }).decision === "superseded",
      )
    )
      throw new Error("Injected transition rollback");
    return result;
  });
  await expect(
    k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile: "approve-for-me",
      expectedRevision: 0,
    }),
  ).rejects.toThrow("Injected transition rollback");
  expect(
    (
      await f.db
        .selectFrom("conversations")
        .select("permission_revision")
        .where("id", "=", f.conversationId)
        .executeTakeFirst()
    )?.permission_revision,
  ).toBe(0);
  expect((await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))?.status).toBe(
    "pending",
  );
  expect(
    await f.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("type", "=", "permission_profile_changed")
      .execute(),
  ).toEqual([]);
  expect(
    await f.db
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "conversation.permission_profile_changed")
      .execute(),
  ).toEqual([]);
  expect(
    await f.db
      .selectFrom("outbox")
      .select("id")
      .where("job_name", "=", "permission-approval-recheck")
      .execute(),
  ).toEqual([]);
});
it("local current host ceiling refuses an unapproved host before independent review", async () => {
  const f = await fixture(
    "Bash",
    { command: "curl https://not-in-org-ceiling.example/data" },
    true,
  );
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(review).not.toHaveBeenCalled();
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
});

it.each([
  "cat /home/owner/.ssh/id_rsa",
  "sudo true",
  "launchctl load /work/agent.plist",
  "rm -rf /",
])("Full retains fixed denial while skipping discretionary review: %s", async (command) => {
  const f = await fixture("Bash", { command }, true);
  const view = await k.app
    .get(PermissionProfilesService)
    .get(f.orgId, f.conversationId, f.accountId);
  await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "full-access",
    expectedRevision: 0,
    consentScopeRevision: view.scopeRevision ?? undefined,
  });
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(f.effects()).toBe(command === "rm -rf /" ? 0 : 1);
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
});
it("Full retains mandatory tool ask ahead of the staged discretionary branch", async () => {
  const f = await fixture("Bash", { command: "python generated.py" }, true);
  const registry = k.app.get(ToolRegistry),
    resolved = await registry.forAgent(f.orgId, { ...f.ctx.agent, source: "web" });
  vi.mocked(registry.forAgent).mockResolvedValue({
    ...resolved,
    tools: resolved.tools.map((tool) => ({
      ...tool,
      defaultPolicy: "ask" as const,
      spec: { ...tool.spec, annotations: { requiresUserInteraction: true } },
    })),
  });
  const view = await k.app
    .get(PermissionProfilesService)
    .get(f.orgId, f.conversationId, f.accountId);
  await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
    profile: "full-access",
    expectedRevision: 0,
    consentScopeRevision: view.scopeRevision ?? undefined,
  });
  const result = await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep(f.ctx),
  );
  expect(result.kind).toBe("suspended");
  expect(f.effects()).toBe(0);
  expect(
    (
      await f.db
        .selectFrom("approvals")
        .select("kind")
        .where("run_id", "=", f.runId)
        .executeTakeFirst()
    )?.kind,
  ).toBe("tool");
});

it.each([
  ["request-approval", "Write", "/work/package.json"],
  ["approve-for-me", "Write", "/work/package.json"],
  ["request-approval", "Edit", "/work/generated.py"],
  ["approve-for-me", "Edit", "/work/generated.py"],
] as const)(
  "%s %s of %s uses base scope without reviewer or approval",
  async (profile, tool, path) => {
    const f = await fixture(tool, { file_path: path }, true);
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: profile })
      .where("id", "=", f.conversationId)
      .execute();
    const chat = vi.spyOn(k.app.get(ModelPurposesService), "chat");
    const result = await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
    expect(result.kind).toBe("done");
    expect(f.effects()).toBe(1);
    expect(chat).not.toHaveBeenCalled();
    expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
    expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
    expect(f.scopes[0]?.filesystem).toEqual({
      kind: "scoped",
      readRoots: ["/skills", "/work"],
      writeRoots: ["/work"],
    });
  },
);

import { currentStore } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import { PermissionInstanceWrites } from "../../src/sandbox/permission-instance-writes.js";
import { PermissionTransitions } from "../../src/sandbox/permission-transitions.js";
import { PermissionApprovalJobs } from "../../src/tools/permission-approval-jobs.js";

it.each([
  { writer: "profile", rollback: false },
  { writer: "profile", rollback: true },
  { writer: "instance", rollback: false },
  { writer: "instance", rollback: true },
] as const)(
  "$writer transition hints respect commit (rollback=$rollback) and a mandatory child wait",
  async ({ writer, rollback }) => {
    const f = await fixture("Write", { file_path: "/outside/reports/report.txt" }, true);
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: "request-approval" })
      .where("id", "=", f.conversationId)
      .execute();
    await k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
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
    for (const callId of ["child-first", "child-last"]) {
      await k.app.get(ApprovalsService).requestCommand({
        orgId: f.orgId,
        conversationId: childId,
        runId: childRunId,
        callId,
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
    }
    await f.db
      .insertInto("approvals")
      .values({
        id: "mandatory",
        org_id: f.orgId,
        conversation_id: childId,
        run_id: childRunId,
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
    if (writer === "instance")
      await f.db
        .updateTable("conversations")
        .set({ permission_profile: "full-access" })
        .where("id", "=", f.conversationId)
        .execute();
    const before = await f.db
      .selectFrom("conversations")
      .select(["id", "last_seq", "permission_revision"])
      .where("id", "in", [f.conversationId, childId])
      .orderBy("id")
      .execute();
    const log = k.app.get(EventLog),
      notify = log.notify.bind(log);
    const observed: {
      conversationId: string;
      seq: number;
      inTransaction: boolean;
      committedSeq: number;
    }[] = [];
    vi.spyOn(log, "notify").mockImplementation(async (conversationId, seq) => {
      const committed = await f.db
        .selectFrom("conversations")
        .select("last_seq")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow();
      observed.push({
        conversationId,
        seq,
        inTransaction: currentStore() !== undefined,
        committedSeq: Number(committed.last_seq),
      });
      await notify(conversationId, seq);
    });
    const outbox = k.app.get(OutboxService),
      add = outbox.add.bind(outbox);
    vi.spyOn(outbox, "add").mockImplementation(async (job) => {
      const result = await add(job);
      if (job.name === "permission-approval-recheck") {
        expect(observed).toEqual([]);
      }
      return result;
    });
    if (rollback) {
      const transitions = k.app.get(PermissionTransitions),
        record = transitions.recordLocked.bind(transitions);
      vi.spyOn(transitions, "recordLocked").mockImplementation(async (...args) => {
        await record(...args);
        expect(currentStore()?.hooks.length).toBeGreaterThan(0);
        expect(observed).toEqual([]);
        throw new Error("rollback transition fixture");
      });
    }
    const bus = k.app.get<ExtensionContext["bus"]>(KERNEL_BUS),
      messages: { conversationId: string; message: unknown }[] = [];
    const offs = await Promise.all(
      [f.conversationId, childId].map((conversationId) =>
        bus.subscribe(conversationTopic(conversationId), (message) => {
          messages.push({ conversationId, message });
        }),
      ),
    );
    try {
      const writing =
        writer === "profile"
          ? k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
              profile: "approve-for-me",
              expectedRevision: 0,
            })
          : k.app
              .get(PermissionInstanceWrites)
              .commitHandle(
                f.orgId,
                f.deviceId,
                0,
                { ...DEFAULT_SANDBOX_ROOTS, workspace: "/changed" },
                {},
                new AbortController().signal,
              );
      if (rollback) await expect(writing).rejects.toThrow("rollback transition fixture");
      else await writing;
      const after = await f.db
        .selectFrom("conversations")
        .select(["id", "last_seq", "permission_revision"])
        .where("id", "in", [f.conversationId, childId])
        .orderBy("id")
        .execute();
      const jobs = await f.db
        .selectFrom("outbox")
        .select("job_id")
        .where("job_name", "=", "permission-approval-recheck")
        .execute();
      if (rollback) {
        expect(after).toEqual(before);
        expect(observed).toEqual([]);
        expect(messages).toEqual([]);
        expect(jobs).toEqual([]);
      } else {
        expect(observed).toHaveLength(2);
        for (const row of after) {
          expect(observed.find((e) => e.conversationId === row.id)).toEqual({
            conversationId: row.id,
            seq: Number(row.last_seq),
            committedSeq: Number(row.last_seq),
            inTransaction: false,
          });
        }
        await expect.poll(() => messages.length).toBe(2);
        for (const row of after)
          expect(messages).toContainEqual({
            conversationId: row.id,
            message: { kind: "events", toSeq: Number(row.last_seq) },
          });
        expect(jobs).toEqual([{ job_id: `permission-recheck-${f.conversationId}-1` }]);
        await k.app
          .get(PermissionApprovalJobs)
          .recheck({ orgId: f.orgId, rootConversationId: f.conversationId, revision: 1 });
        expect(
          (
            await f.db
              .selectFrom("runs")
              .select("status")
              .where("id", "=", childRunId)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe("waiting");
        expect(
          (
            await f.db
              .selectFrom("approvals")
              .select("status")
              .where("id", "=", "mandatory")
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe("pending");
        expect(
          (
            await f.db
              .selectFrom("conversations")
              .select("last_seq")
              .where("id", "=", childId)
              .executeTakeFirstOrThrow()
          ).last_seq,
        ).toEqual(after.find((row) => row.id === childId)?.last_seq);
      }
      const cards = await f.db
        .selectFrom("approvals")
        .select("status")
        .where("kind", "=", "command")
        .execute();
      expect(cards).toHaveLength(3);
      expect(cards.every((card) => card.status === (rollback ? "pending" : "superseded"))).toBe(
        true,
      );
      expect(f.effects()).toBe(0);
    } finally {
      await Promise.all(offs.map((off) => off()));
    }
  },
);
