import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

// Per-call sandbox escalation (approval profiles design, "Per-call sandbox escalation"): a Bash
// call with sandbox: "escalated" crosses the sandbox for that call only, decided by the profile's
// approver within the device's Full access ceiling.

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

const JUSTIFICATION = "The dev server must bind port 3000 on the machine.";
const ESCALATED = { command: "npm run dev", sandbox: "escalated", justification: JUSTIFICATION };

async function escalated(
  profile: "request-approval" | "approve-for-me" | "full-access",
  input: Record<string, unknown> = ESCALATED,
) {
  const f = await permissionFixture(k, raw, "Bash", input, true);
  if (profile === "full-access") {
    const view = await k.app
      .get(PermissionProfilesService)
      .get(f.orgId, f.conversationId, f.accountId);
    await k.app.get(PermissionProfilesService).set(f.orgId, f.conversationId, f.accountId, {
      profile: "full-access",
      expectedRevision: 0,
      consentScopeRevision: view.scopeRevision ?? undefined,
    });
  } else
    await f.db
      .updateTable("conversations")
      .set({ permission_profile: profile })
      .where("id", "=", f.conversationId)
      .execute();
  const step = () =>
    k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep(f.ctx),
    );
  const results = async () =>
    (
      await f.db
        .selectFrom("conversation_events")
        .select("payload")
        .where("type", "=", "tool_result")
        .where("run_id", "=", f.runId)
        .orderBy("seq")
        .execute()
    ).map(
      (r) => r.payload as { callId: string; content: unknown; isError?: boolean; review?: unknown },
    );
  /** A second call of the same run, at the next step (the model's next tool call). */
  const nextCall = async (next: Record<string, unknown>) => {
    const callId = randomUUID();
    await k.app.get(EventLog).append(f.conversationId, [
      {
        type: "assistant_message",
        runId: f.runId,
        idemKey: assistantIdemKey(f.runId, 2),
        payload: {
          step: 2,
          stopReason: "tool_use",
          content: [{ type: "tool_call", id: callId, name: "Bash", input: next }],
        },
      },
    ]);
    return k.app.get(RunExecution).withClaim(
      f.claim,
      () => true,
      () => k.app.get(ToolPipeline).runStep({ ...f.ctx, step: 2 }),
    );
  };
  return { ...f, step, results, nextCall };
}

it("Request approval asks the person with the command, cwd and justification; the approval runs this call outside the sandbox and the next call inside it", async () => {
  const f = await escalated("request-approval");
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  expect((await f.step()).kind).toBe("suspended");
  expect(f.effects()).toBe(0);
  const ask = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
  expect(ask?.status).toBe("pending");
  expect(ask?.scopes).toEqual(["once"]);
  expect(ask?.command).toMatchObject({
    command: "npm run dev",
    workingRoot: "/work",
    escalation: { justification: JUSTIFICATION },
  });
  expect(ask?.command?.reason).toMatch(/outside the sandbox for this call only/);
  const requested = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "approval_requested")
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect((requested.payload as { command?: unknown }).command).toMatchObject({
    escalation: { justification: JUSTIFICATION },
    workingRoot: "/work",
  });
  await k.app
    .get(ApprovalsService)
    .decide(f.orgId, ask!.id, f.accountId, { decision: "approve", scope: "once" });
  await f.step();
  expect(f.effects()).toBe(1);
  expect(f.scopes[0]).toMatchObject({
    profile: "request-approval",
    filesystem: { kind: "device" },
    network: { kind: "environment" },
  });
  const [grant] = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  expect(grant).toMatchObject({
    scope_kind: "sandbox-escalation",
    source: "human",
    call_id: f.callId,
    escalation: { justification: JUSTIFICATION },
  });
  const [intent] = await f.db.selectFrom("sandbox_operation_intents").selectAll().execute();
  expect(intent?.permission_grant_id).toBe(grant?.id);
  expect((await f.results())[0]?.review).toMatchObject({
    decision: "allow",
    by: "person",
    decisionSource: "human",
    sandbox: "escalated",
  });
  // the next call of the run is sandboxed again: the grant was this call's only
  review.mockClear();
  await f.nextCall({ command: "npm test" });
  expect(f.effects()).toBe(2);
  expect(f.scopes.at(-1)?.filesystem).toMatchObject({ kind: "scoped" });
  expect(f.scopes.at(-1)?.network.kind).not.toBe("environment");
});

it("an approved escalation is bound to its call: a changed input never matches the grant", async () => {
  const f = await escalated("request-approval");
  await f.step();
  const ask = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  await k.app
    .get(ApprovalsService)
    .decide(f.orgId, ask.id, f.accountId, { decision: "approve", scope: "once" });
  const candidate = ask.command!.permissionCandidate!;
  const changed = { ...candidate.binding, callInputHash: "0".repeat(64) };
  const lookup = (binding: typeof changed) =>
    k.app.get(TransactionHost).run(async () => {
      await k.app.get(PermissionAuthorityLock).acquire(
        {
          orgId: f.orgId,
          deviceId: f.deviceId,
          rootConversationId: f.conversationId,
        },
        { kind: "admit" },
      );
      return k.app.get(PermissionCallGrants).findForAdmission(binding);
    });
  expect(await lookup(changed)).toBeNull();
  expect(await lookup(candidate.binding)).toMatchObject({ scopeKind: "sandbox-escalation" });
  // nor can its evidence be replayed to issue a grant for another input
  await expect(
    k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(PermissionAuthorityLock)
        .acquire(
          { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
          { kind: "admit" },
        );
      return k.app
        .get(PermissionCallGrants)
        .issueLocked(
          { ...candidate, binding: changed },
          { source: "human", approvalId: ask.id, decidedBy: f.accountId },
        );
    }),
  ).rejects.toThrow();
});

it("Approve for me sends it to the review model; its allow runs this call outside the sandbox", async () => {
  const f = await escalated("approve-for-me");
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "classifier",
    reason: "Starting the requested dev server.",
    rule: null,
  });
  await f.step();
  expect(f.effects()).toBe(1);
  expect(f.scopes[0]).toMatchObject({ filesystem: { kind: "device" } });
  const reviewed = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "permission_reviewed")
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect(reviewed.payload).toMatchObject({
    scopeKind: "sandbox-escalation",
    escalation: { justification: JUSTIFICATION },
    outcome: "allow",
    decisionSource: "review-model",
  });
  const [grant] = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  expect(grant).toMatchObject({ scope_kind: "sandbox-escalation", source: "review-model" });
  expect((await f.results())[0]?.review).toMatchObject({
    decisionSource: "review-model",
    sandbox: "escalated",
  });
});

it.each(["deny", "ask"] as const)(
  "Approve for me: the review model's %s never runs it outside the sandbox",
  async (decision) => {
    const f = await escalated("approve-for-me");
    vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
      decision,
      by: "classifier",
      reason: "Not needed.",
      rule: null,
    });
    const result = await f.step();
    expect(f.effects()).toBe(0);
    expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
    if (decision === "deny") {
      expect(result.kind).toBe("done");
      expect((await f.results())[0]).toMatchObject({ isError: true });
    } else {
      expect(result.kind).toBe("suspended");
      const ask = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
      expect(ask?.command?.escalation).toEqual({ justification: JUSTIFICATION });
    }
  },
);

it("a fixed deny stays a deny for an escalated command", async () => {
  const f = await escalated("request-approval", { ...ESCALATED, command: "rm -rf /" });
  await f.step();
  expect(f.effects()).toBe(0);
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
  expect((await f.results())[0]).toMatchObject({ isError: true });
});

it("Full access asks nobody: the call already runs outside the sandbox", async () => {
  const f = await escalated("full-access");
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await f.step();
  expect(f.effects()).toBe(1);
  expect(f.scopes[0]).toMatchObject({ profile: "full-access", filesystem: { kind: "device" } });
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  for (const [input] of review.mock.calls) expect(input.permissionProfile).toBe("full-access");
});

it.each(["request-approval", "approve-for-me"] as const)(
  "%s: a ceiling that forbids Full access refuses the escalation with what to do instead",
  async (profile) => {
    const f = await escalated(profile);
    await k.app.get(OrgSettingsService).update(f.orgId, { fullAccess: "off" }, f.accountId);
    const review = vi.spyOn(k.app.get(CommandReviewService), "review");
    await f.step();
    expect(f.effects()).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
    const [result] = await f.results();
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toMatch(
      /not allowed on this device.*Call Bash without sandbox/,
    );
  },
);

it("an unattended run cannot escalate", async () => {
  const f = await escalated("request-approval");
  // the authority's own facts say the run serves a scheduled task (unattended)
  const authority = k.app.get(SandboxOperationAuthority);
  const preview = authority.previewCall.bind(authority);
  vi.spyOn(authority, "previewCall").mockImplementation(async (...args) => ({
    ...(await preview(...args)),
    unattended: true,
  }));
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await f.step();
  expect(f.effects()).toBe(0);
  expect(review).not.toHaveBeenCalled();
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
  expect(JSON.stringify((await f.results())[0]?.content)).toMatch(/unattended run/);
});

it("a missing justification is refused before any review", async () => {
  const f = await escalated("request-approval", { command: "npm run dev", sandbox: "escalated" });
  await f.step();
  expect(f.effects()).toBe(0);
  expect(JSON.stringify((await f.results())[0]?.content)).toMatch(/Retry with justification/);
});

it("a restricted command's outside write is refused with the escalation hint where it is possible", async () => {
  const f = await escalated("request-approval", { command: "echo x > /outside/file.txt" });
  await f.step();
  expect(f.effects()).toBe(0);
  expect(JSON.stringify((await f.results())[0]?.content)).toMatch(
    /sandbox: \\"escalated\\" and justification/,
  );
});
