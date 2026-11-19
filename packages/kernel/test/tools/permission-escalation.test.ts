import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import { SettingsService } from "../../src/identity/settings.js";
import {
  runOutsideTransaction,
  TransactionHost,
} from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { ESCALATION_GRANT_MISSING_TEXT } from "../../src/tools/builtins/sandbox/common.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { SUPPORTS_BOTH, seedInstalledEvidence } from "../helpers/installed-evidence.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { storedOwnerReport } from "../helpers/owner-report.js";
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

// approval-only profiles design: Full access keeps the sandbox, so its escalation is a real,
// audited auto-grant within the outside-sandbox ceiling (it replaces "Full access asks nobody: the
// call already runs outside the sandbox")
it("Full access auto-grants the escalation: one grant, its event and audit row, and it runs outside", async () => {
  const f = await escalated("full-access");
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await f.step();
  expect(f.effects()).toBe(1);
  expect(f.scopes[0]).toMatchObject({ filesystem: { kind: "device" } });
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
  // the fixed denies were evaluated first, with the profile
  for (const [input] of review.mock.calls) expect(input.permissionProfile).toBe("full-access");
  const grants = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    scope_kind: "sandbox-escalation",
    source: "full-access",
    escalation: { justification: JUSTIFICATION },
  });
  const reviewed = await f.db
    .selectFrom("conversation_events")
    .select(["seq", "payload"])
    .where("type", "=", "permission_reviewed")
    .where("run_id", "=", f.runId)
    .execute();
  expect(reviewed.map((r) => r.payload)).toMatchObject([
    { outcome: "allow", decisionSource: "full-access", crossing: "outside-sandbox" },
  ]);
  const audits = await f.db
    .selectFrom("audit_events")
    .select("detail")
    .where("action", "=", "permission.crossing_auto_granted")
    .execute();
  expect(audits.map((a) => a.detail)).toMatchObject([
    { kind: "outside-sandbox", callId: f.callId, justification: JUSTIFICATION },
  ]);
  expect((await f.results())[0]?.review).toMatchObject({
    decisionSource: "full-access",
    sandbox: "escalated",
    crossing: "outside-sandbox",
  });
});

it("an exact retry of a Full access auto-grant returns the same grant; other evidence conflicts", async () => {
  const f = await escalated("full-access");
  await f.step();
  const [first] = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  const event = await f.db
    .selectFrom("conversation_events")
    .select(["seq", "payload"])
    .where("type", "=", "permission_reviewed")
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  const {
    outcome: _o,
    reason: _r,
    decisionSource: _d,
    crossing: _c,
    ...candidate
  } = event.payload as Record<string, unknown>;
  const issue = (reviewEventSeq: number) =>
    k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(PermissionAuthorityLock)
        .acquire(
          { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
          { kind: "admit" },
        );
      return k.app.get(PermissionCallGrants).issueLocked(candidate as never, {
        source: "full-access",
        reviewEventSeq,
        decidedBy: null,
      });
    });
  expect(await issue(Number(event.seq))).toEqual({ id: first?.id });
  await expect(issue(Number(event.seq) + 1000)).rejects.toThrow();
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toHaveLength(1);
  // the review model's source never stands on a Full access event: its recorded verdict must be
  // the review model's own
  await expect(
    k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(PermissionAuthorityLock)
        .acquire(
          { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
          { kind: "admit" },
        );
      return k.app.get(PermissionCallGrants).issueLocked(candidate as never, {
        source: "review-model",
        reviewEventSeq: Number(event.seq),
        decidedBy: null,
      });
    }),
  ).rejects.toThrow(/requires its recorded allow verdict/);
});

it("Full access: a sub-agent's escalation goes to the review model, never auto-granted", async () => {
  const f = await escalated("full-access");
  const child = await subAgentCall(f);
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  // no review model mapped: the review model's place falls back to the person
  const result = await child.step();
  expect(review.mock.calls[0]?.[0]).toMatchObject({ permissionProfile: "full-access" });
  expect(review.mock.calls[0]?.[0].parentRunId).toBe(f.runId);
  expect(result.kind).toBe("suspended");
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  expect(
    await f.db
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "permission.crossing_auto_granted")
      .execute(),
  ).toEqual([]);
  const ask = await k.app.get(ApprovalsService).commandForCall(child.runId, child.callId);
  expect(ask).toMatchObject({ status: "pending", requestedFor: f.accountId, scopes: ["once"] });
  expect(ask?.command?.escalation).toEqual({ justification: JUSTIFICATION });
});

it("Full access: a sub-agent's escalation the review model allows is its grant", async () => {
  const f = await escalated("full-access");
  const child = await subAgentCall(f);
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "classifier",
    reason: "Starting the requested dev server.",
    rule: null,
  });
  await child.step();
  expect(f.effects()).toBe(1);
  const grants = await f.db.selectFrom("permission_call_grants").selectAll().execute();
  expect(grants).toMatchObject([{ source: "review-model", scope_kind: "sandbox-escalation" }]);
});

it.each(["request-approval", "approve-for-me"] as const)(
  "%s: a ceiling that forbids Full access refuses the escalation with what to do instead",
  async (profile) => {
    const f = await escalated(profile);
    await k.app.get(OrgSettingsService).update(f.orgId, { outsideSandbox: "off" }, f.accountId);
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

/** The escalated call's admitted intents (an escalated one has full reach). */
const intentsOf = (f: { db: Awaited<ReturnType<typeof escalated>>["db"]; runId: string }) =>
  f.db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .where("run_id", "=", f.runId)
    .orderBy("created_at")
    .execute();

/** Runs `before` inside the tool's handler, after the review and before admission. */
function beforeAdmission(run: () => Promise<void>) {
  const registry = k.app.get(ToolRegistry);
  const handler = registry.handler({} as never);
  if (!handler) throw new Error("the fixture has no handler");
  vi.mocked(registry.handler).mockReturnValue(async (input, ctx) => {
    await run();
    return handler(input, ctx);
  });
}

const reviewAllows = () =>
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "classifier",
    reason: "Starting the requested dev server.",
    rule: null,
  });

/** The super admin turns the platform's Full switch off (restored by `platformFullBack`). */
async function platformFull(permission: "off" | "allowed") {
  const admin = await accountsFor(raw as never).createLocal({
    login: `admin-${randomUUID().slice(0, 8)}`,
    password: "Passw0rd!Passw0rd",
    displayName: "Admin",
    superAdmin: true,
  });
  await k.app.get(SettingsService).update({ devicesOutsideSandbox: { permission } }, admin.id);
}

it("a background escalation discloses that it keeps running outside the sandbox, at most its deadline", async () => {
  const f = await escalated("request-approval", {
    ...ESCALATED,
    run_in_background: true,
    timeout: 600_000,
  });
  await f.step();
  expect(f.effects()).toBe(0);
  const ask = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
  expect(ask?.command?.escalation).toEqual({
    justification: JUSTIFICATION,
    background: true,
    maxSeconds: 600,
  });
  expect(ask?.command?.reason).toMatch(
    /starts a background process that keeps running outside the sandbox until it exits or is stopped, at most 10 minutes/,
  );
  const requested = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "approval_requested")
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect((requested.payload as { command?: unknown }).command).toMatchObject({
    escalation: { justification: JUSTIFICATION, background: true, maxSeconds: 600 },
  });
});

it("a second escalated call with the same command but another callId asks again", async () => {
  const f = await escalated("request-approval");
  await f.step();
  const first = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
  await k.app
    .get(ApprovalsService)
    .decide(f.orgId, first.id, f.accountId, { decision: "approve", scope: "once" });
  await f.step();
  expect(f.effects()).toBe(1);
  expect((await f.nextCall(ESCALATED)).kind).toBe("suspended");
  expect(f.effects()).toBe(1);
  const asks = await f.db
    .selectFrom("approvals")
    .select(["call_id", "status"])
    .where("run_id", "=", f.runId)
    .orderBy("created_at")
    .execute();
  expect(asks).toHaveLength(2);
  expect(asks[1]).toMatchObject({ status: "pending" });
  expect(asks[1]?.call_id).not.toBe(f.callId);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toHaveLength(1);
});

it("a grant missed at admission fails with an actionable text, never a silent sandboxed run", async () => {
  const f = await escalated("approve-for-me");
  reviewAllows();
  vi.spyOn(k.app.get(PermissionCallGrants), "findForAdmission").mockResolvedValue(null);
  await f.step();
  expect(f.effects()).toBe(0);
  const [result] = await f.results();
  expect(result?.isError).toBe(true);
  expect(result?.content).toBe(ESCALATION_GRANT_MISSING_TEXT);
  expect(ESCALATION_GRANT_MISSING_TEXT).toMatch(/no longer matches.*ask again/);
  // the record names what was admitted, not what was asked: nothing ran outside the sandbox
  expect(result?.review).toMatchObject({ decision: "allow", decisionSource: "review-model" });
  expect((result?.review as { sandbox?: unknown } | undefined)?.sandbox).toBeUndefined();
});

it.each(["approve-for-me", "request-approval"] as const)(
  "%s: the device authority changing after the review refuses at admission",
  async (profile) => {
    const f = await escalated(profile);
    if (profile === "approve-for-me") reviewAllows();
    else {
      await f.step();
      const ask = (await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId))!;
      await k.app
        .get(ApprovalsService)
        .decide(f.orgId, ask.id, f.accountId, { decision: "approve", scope: "once" });
    }
    // a device-level authority change between the review and admission (an owner ceiling or
    // root change publishes the same way): the call's grant no longer matches
    beforeAdmission(() =>
      runOutsideTransaction(() =>
        k.app.get(TransactionHost).run(async () => {
          const writes = k.app.get(PermissionCeilingWrites);
          await writes.lock({ orgId: f.orgId, deviceId: f.deviceId }, "device");
          await writes.publishLocked({ orgId: f.orgId, deviceId: f.deviceId }, "device", false);
        }),
      ),
    );
    await f.step();
    expect(f.effects()).toBe(0);
    const [result] = await f.results();
    expect(result?.isError).toBe(true);
    expect(result?.content).toBe(ESCALATION_GRANT_MISSING_TEXT);
    expect((result?.review as { sandbox?: unknown } | undefined)?.sandbox).toBeUndefined();
  },
);

it("an owner ceiling of sandbox refuses the escalation before any review", async () => {
  const f = await escalated("request-approval");
  await f.db
    .updateTable("device_machines")
    .set({ owner_report: storedOwnerReport({ outsideSandbox: false }) })
    .where("device_id", "=", f.deviceId)
    .execute();
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await f.step();
  expect(f.effects()).toBe(0);
  expect(review).not.toHaveBeenCalled();
  expect(JSON.stringify((await f.results())[0]?.content)).toMatch(
    /not allowed on this device.*Call Bash without sandbox/,
  );
});

it("a platform Full switch off refuses the escalation before any review", async () => {
  const f = await escalated("request-approval");
  await platformFull("off");
  try {
    const review = vi.spyOn(k.app.get(CommandReviewService), "review");
    await f.step();
    expect(f.effects()).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(JSON.stringify((await f.results())[0]?.content)).toMatch(/not allowed on this device/);
  } finally {
    await platformFull("allowed");
  }
});

it("a runtime that cannot run Full access refuses the escalation with its reason", async () => {
  const f = await escalated("request-approval");
  await seedInstalledEvidence(k, raw, {
    orgId: f.orgId,
    deviceId: f.deviceId,
    provider: "@permission-policy-test",
    version: "test-1",
    report: { ...SUPPORTS_BOTH, outsideSandbox: false },
  });
  const review = vi.spyOn(k.app.get(CommandReviewService), "review");
  await f.step();
  expect(f.effects()).toBe(0);
  expect(review).not.toHaveBeenCalled();
  expect(JSON.stringify((await f.results())[0]?.content)).toMatch(
    /cannot run commands outside its sandbox now/,
  );
});

it.each(["org", "platform"] as const)(
  "a running escalated command is revoked when the %s Full switch turns off",
  async (writer) => {
    const f = await escalated("approve-for-me");
    reviewAllows();
    let revokedWhileRunning: unknown;
    f.setEffectHook(async (scope, method) => {
      if (method !== "exec" || scope.filesystem.kind !== "device") return;
      if (writer === "org")
        await k.app.get(OrgSettingsService).update(f.orgId, { outsideSandbox: "off" }, f.accountId);
      else await platformFull("off");
      revokedWhileRunning = (await intentsOf(f)).map((i) => i.state);
    });
    try {
      await f.step();
    } finally {
      if (writer === "platform") await platformFull("allowed");
    }
    expect(revokedWhileRunning).toEqual(["revoked"]);
    const owed = await f.db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", "sandbox-operation-revoke")
      .execute();
    const [intent] = await intentsOf(f);
    expect(owed.map((o) => o.job_id)).toContain(`sandbox-operation-revoke-${intent?.operation_id}`);
  },
);

it("another member's run in the owner's conversation never escalates on the owner's device", async () => {
  const f = await escalated("request-approval");
  const other = randomUUID();
  await f.db.insertInto("accounts").values({ id: other, display_name: "Other" }).execute();
  await f.db
    .insertInto("memberships")
    .values({ org_id: f.orgId, account_id: other, role: "member" })
    .execute();
  await f.db
    .updateTable("runs")
    .set({ trigger_account_id: other })
    .where("id", "=", f.runId)
    .execute();
  await k.app.get(RunExecution).withClaim(
    f.claim,
    () => true,
    () => k.app.get(ToolPipeline).runStep({ ...f.ctx, accountId: other, role: "member" }),
  );
  expect(f.effects()).toBe(0);
  expect(await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId)).toBeNull();
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  expect((await f.results())[0]?.isError).toBe(true);
});

/** A sub-agent of the fixture's conversation, whose first call is the escalated `Bash`. */
async function subAgentCall(f: Awaited<ReturnType<typeof escalated>>) {
  const childId = randomUUID(),
    childRunId = randomUUID(),
    childExecution = randomUUID(),
    childCall = randomUUID();
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
      execution_id: childExecution,
      status: "running",
      agent_version: 1,
      trigger_account_id: f.accountId,
      trigger_seq: 0,
    })
    .execute();
  await k.app.get(EventLog).append(childId, [
    {
      type: "assistant_message",
      runId: childRunId,
      idemKey: assistantIdemKey(childRunId, 1),
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: childCall, name: "Bash", input: ESCALATED }],
      },
    },
  ]);
  const step = () =>
    k.app.get(RunExecution).withClaim(
      { ...f.claim, conversationId: childId, runId: childRunId, executionId: childExecution },
      () => true,
      () =>
        k.app.get(ToolPipeline).runStep({
          ...f.ctx,
          conversationId: childId,
          runId: childRunId,
          parent: {
            conversationId: f.conversationId,
            runId: f.runId,
            callId: f.callId,
            depth: 0,
            rootConversationId: f.conversationId,
          },
        }),
    );
  return { conversationId: childId, runId: childRunId, callId: childCall, step };
}

it("a sub-agent's escalation asks the owner, in the root's permission context", async () => {
  const f = await escalated("request-approval");
  const child = await subAgentCall(f);
  const result = await child.step();
  expect(result.kind).toBe("suspended");
  expect(f.effects()).toBe(0);
  const ask = await k.app.get(ApprovalsService).commandForCall(child.runId, child.callId);
  expect(ask).toMatchObject({ status: "pending", requestedFor: f.accountId, scopes: ["once"] });
  expect(ask?.command?.escalation).toEqual({ justification: JUSTIFICATION });
  expect(ask?.command?.permissionCandidate?.binding).toMatchObject({
    rootConversationId: f.conversationId,
    conversationId: child.conversationId,
    accountId: f.accountId,
  });
});

it("Full access: an escalation whose grant is missed at admission is refused, never run sandboxed", async () => {
  const f = await escalated("full-access");
  vi.spyOn(k.app.get(PermissionCallGrants), "findForAdmission").mockResolvedValue(null);
  await f.step();
  expect(f.effects()).toBe(0);
  const [result] = await f.results();
  expect(result?.isError).toBe(true);
  expect(result?.content).toBe(ESCALATION_GRANT_MISSING_TEXT);
  expect((result?.review as { sandbox?: unknown } | undefined)?.sandbox).toBeUndefined();
});

it("Full access: a sensitive consent carried by an auto-granted escalation is recorded with it", async () => {
  const f = await escalated("full-access", {
    ...ESCALATED,
    command: "sudo systemctl restart nginx",
  });
  await f.step();
  expect(f.effects()).toBe(1);
  const audit = await f.db
    .selectFrom("audit_events")
    .select("detail")
    .where("action", "=", "permission.crossing_auto_granted")
    .executeTakeFirstOrThrow();
  expect(audit.detail).toMatchObject({ kind: "outside-sandbox", sensitive: ["ask.sudo"] });
  const reviewed = await f.db
    .selectFrom("conversation_events")
    .select("payload")
    .where("type", "=", "permission_reviewed")
    .where("run_id", "=", f.runId)
    .executeTakeFirstOrThrow();
  expect(reviewed.payload).toMatchObject({
    decisionSource: "full-access",
    sensitive: ["ask.sudo"],
  });
  expect((await f.results())[0]?.review).toMatchObject({
    rule: "ask.sudo",
    decisionSource: "full-access",
    sandbox: "escalated",
  });
});

// maintainer ruling 2026-11-19: under Full access an escalation that touches credentials goes to
// the review model (the person when it is missing or unsure), never to an auto-grant
it("Full access: an escalation carrying a credential consent goes to the review model, not auto-granted", async () => {
  const f = await escalated("full-access", {
    ...ESCALATED,
    command: "cat ~/.ssh/id_ed25519.pub",
  });
  const result = await f.step();
  // no review model mapped: its place falls back to the person
  expect(result.kind).toBe("suspended");
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  expect(
    await f.db
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "permission.crossing_auto_granted")
      .execute(),
  ).toEqual([]);
  const ask = await k.app.get(ApprovalsService).commandForCall(f.runId, f.callId);
  expect(ask?.status).toBe("pending");
  expect(ask?.command?.rule).toBe("ask.ssh");
});

it("Full access: the review model's allow of a credential escalation is its grant", async () => {
  const f = await escalated("full-access", {
    ...ESCALATED,
    command: "cat ~/.ssh/id_ed25519.pub",
  });
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "classifier",
    reason: "The person asked for the public key.",
    rule: null,
    approver: "review-model",
  });
  await f.step();
  expect(f.effects()).toBe(1);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toMatchObject([
    { source: "review-model", scope_kind: "sandbox-escalation" },
  ]);
});

// R3 final review m2: issuance re-derives the credential consent from the recorded command, so a
// Full access auto-grant never covers a credential escalation even when the pipeline erred
it("Full access: issuance refuses an auto-grant of a credential escalation the pipeline let through", async () => {
  const f = await escalated("full-access", {
    ...ESCALATED,
    command: "cat ~/.ssh/id_ed25519.pub",
  });
  // a pipeline that lost the consent: the review answers that nobody needs to approve
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "rule",
    reason: "Full access grants this crossing within the device's limits.",
    rule: null,
    crossing: "outside-sandbox",
    approver: "none",
  });
  await f.step().catch(() => undefined);
  expect(f.effects()).toBe(0);
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toEqual([]);
  expect(
    await f.db
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "permission.crossing_auto_granted")
      .execute(),
  ).toEqual([]);
});
