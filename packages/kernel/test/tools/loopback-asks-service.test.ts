import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AutomationInsert, AutomationStore } from "../../src/automations/store.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceAccessService } from "../../src/device-access/device-access.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { ExecutionRevoked } from "../../src/runtime/run-execution.js";
import { Waits } from "../../src/runtime/waits.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import { LoopbackGrants } from "../../src/sandbox/loopback-grants.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { ESCALATION_UNATTENDED_WHY } from "../../src/sandbox/review/permission-candidate.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import {
  loopbackDeniedNote,
  loopbackExpiredNote,
  loopbackGrantedNote,
  loopbackReviewDeniedNote,
} from "../../src/tools/loopback-asks.js";
import { addressLayerNote } from "../../src/tools/network-asks.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { fakeDeviceAccessCalls } from "../fixtures/extensions/fake-device-access/index.js";
import {
  FAKE_PERMISSION_SUPPORT,
  readFakeServiceLoopbackPorts,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  enableExtensions,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Loopback port asks (browser loopback port grants): a device service of an extension declaring
 * `permissions.deviceAccess.loopbackPorts` is refused a local port of the person's own device; the
 * conversation's permission profile decides (Full access grants it, Approve for me asks the review
 * model, Request approval asks the device owner, a sub-agent always goes to the review model), the
 * grant is written for the conversation's root and the call runs again in the next attempt.
 * `fake-device-access`'s `navigate` reports the loopback refusal of a `http://127.0.0.1:…` URL on
 * the first invocation of a call and loads the page on the re-run; with `service: true` it starts
 * the echo service first (every ensure sends the service's live loopback set to `device-fake`).
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const NAVIGATE = "plugin__fake-device-access__navigate";
const URL_3999 = "http://127.0.0.1:3999/";
const SERVICE_ID = "fake-device-access.echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-loopback-asks-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
          FAKE_DEVICE_ACCESS,
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-device-access");
  // the org's effective hosts take cdn.example.org (the device's own list holds only a.dev)
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { deviceNetwork: { extraHosts: ["cdn.example.org"] } },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  agentId: string;
  conversationId: string;
}

let s: Setup;

/**
 * A member with a session, a `device-fake` device of their own (its provider supports loopback
 * ports), an agent with the navigate tool (and `Agent`), and a conversation on the device. The
 * echo service's launch passes the command review (its classification is the review's own
 * tests' concern).
 */
beforeEach(async () => {
  fakeDeviceAccessCalls().splice(0);
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "rule",
    reason: "test",
    rule: null,
  });
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      name: "Box",
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify(["a.dev"]),
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Browser",
        instructions: "Use the browser.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  const conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  s = { accountId, req, deviceId, agentId, conversationId };
});

afterEach(async () => {
  vi.restoreAllMocks();
  // no service process outlives the test
  await k.app
    .get(DeviceServices)
    .stop(
      {
        orgId,
        deviceId: s.deviceId,
        holderConversationId: s.conversationId,
        actor: { accountId: s.accountId, conversationId: s.conversationId },
      },
      SERVICE_ID,
      AbortSignal.timeout(30_000),
    )
    .catch(() => {});
});

/** The conversation's permission profile (Full access with the device's current consent). */
async function profile(p: "request-approval" | "approve-for-me" | "full-access") {
  if (p === "full-access") {
    const profiles = k.app.get(PermissionProfilesService);
    const view = await profiles.get(orgId, s.conversationId, s.accountId);
    await profiles.set(orgId, s.conversationId, s.accountId, {
      profile: "full-access",
      expectedRevision: view.revision,
      consentScopeRevision: view.scopeRevision ?? undefined,
    });
    return;
  }
  await db
    .updateTable("conversations")
    .set({ permission_profile: p })
    .where("id", "=", s.conversationId)
    .execute();
}

/** The model calls `navigate` on the local port once (starting the echo service first). */
const navigate = (url = URL_3999) =>
  postMessage(s.req, orgId, s.conversationId, `tool:${NAVIGATE}:${navigateInput(url)}`);
const navigateInput = (url = URL_3999, blockedAgain?: string[], ask = false) =>
  JSON.stringify({
    url,
    service: true,
    ...(blockedAgain !== undefined && { blockedAgain }),
    ...(ask && { ask }),
  });

const decide = (id: string, payload: Record<string, unknown>) =>
  s.req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const asks = (conversationId = s.conversationId) =>
  db
    .selectFrom("approvals")
    .select(["id", "status", "tool_key", "scopes", "detail", "requested_for"])
    .where("conversation_id", "=", conversationId)
    .where("kind", "=", "network")
    .execute();

const nextAsk = (conversationId = s.conversationId) =>
  waitFor(
    async () => (await asks(conversationId)).find((a) => a.status === "pending"),
    20_000,
    "a pending loopback ask",
  );

const grants = () =>
  db
    .selectFrom("device_loopback_grants")
    .selectAll()
    .where("device_id", "=", s.deviceId)
    .orderBy("created_at")
    .execute();

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const results = async (conversationId = s.conversationId) =>
  ofType(await eventsOf(db, conversationId), "tool_result").map((e) => e.payload);

/** The navigate invocations so far: one logical call per key, the handler's runs per call. */
const invocations = () => {
  const keys = new Set(fakeDeviceAccessCalls());
  return [...keys].map((key) => fakeDeviceAccessCalls().filter((x) => x === key).length);
};

/** The attempts of the conversation's `tool_call_started` events, in order. */
const startedAttempts = async (conversationId = s.conversationId) =>
  (
    await db
      .selectFrom("conversation_events")
      .select("idem_key")
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "tool_call_started")
      .orderBy("seq")
      .execute()
  ).map((e) => Number(e.idem_key?.split(":")[3] ?? 1));

const sentCount = async () => (await readFakeServiceLoopbackPorts(sandboxRoot)).length;
const sentSince = async (from: number) =>
  (await readFakeServiceLoopbackPorts(sandboxRoot)).slice(from);

/** The provider's support as the facts read it, with `over` applied. */
function supportOverride(over: (s: SandboxPermissionSupport) => SandboxPermissionSupport) {
  const facts = k.app.get(PermissionFacts);
  const original = facts.deviceSandboxFacts.bind(facts);
  vi.spyOn(facts, "deviceSandboxFacts").mockImplementation(async (...args) => {
    const f = await original(...args);
    return {
      ...f,
      support: f.support === null ? null : over(f.support),
      box: { ...f.box, loopbackPorts: false },
    };
  });
}

/** Makes the conversation an automation's (the kernel's own unattended record). */
async function unattended() {
  const task = await new AutomationStore().insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: s.accountId,
    agentId: s.agentId,
    name: "nightly",
    prompt: "nightly",
    trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "paused",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
  } satisfies AutomationInsert);
  await db
    .updateTable("conversations")
    .set({ automation_id: task.id })
    .where("id", "=", s.conversationId)
    .execute();
}

describe("loopback port asks", () => {
  it("full access grants the port with no person and reruns the call", async () => {
    await profile("full-access");
    const from = await sentCount();
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const evs = await eventsOf(db, s.conversationId);
    const [reviewed, ...moreReviews] = ofType(evs, "permission_reviewed");
    expect(moreReviews).toEqual([]);
    expect(reviewed?.payload).toMatchObject({
      scopeKind: "loopback-port",
      decisionSource: "full-access",
      outcome: "allow",
      crossing: "loopback-port",
      permissionScope: { writeDirectories: [], hosts: [] },
      loopback: { service: SERVICE_ID, port: 3999 },
    });
    expect(await startedAttempts()).toEqual([1, 2]);
    const [r, ...rest] = await results();
    expect(rest).toEqual([]);
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    expect(invocations()).toEqual([2]);
    const [g, ...others] = await grants();
    expect(others).toEqual([]);
    expect(g).toMatchObject({
      source: "full-access",
      conversation_id: s.conversationId,
      service_id: SERVICE_ID,
      port: 3999,
      call_id: reviewed?.payload.binding.callId,
      attempt: 1,
      approval_id: null,
    });
    expect(g?.run_id).toBe(reviewed?.runId);
    expect(await sentSince(from)).toContainEqual([3999]);
    expect(await asks()).toEqual([]);
  });

  it("approve-for-me asks the review model and reruns on allow", async () => {
    await profile("approve-for-me");
    const review = vi
      .spyOn(k.app.get(CommandReviewService), "reviewLoopbackPort")
      .mockResolvedValue({
        decision: "allow",
        by: "classifier",
        rule: null,
        reason: "The person asked to open their dev server.",
        approver: "review-model",
      });
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      profile: "approve-for-me",
      attended: true,
      service: SERVICE_ID,
      port: 3999,
      url: URL_3999,
      database: false,
    });
    const evs = await eventsOf(db, s.conversationId);
    expect(ofType(evs, "permission_reviewed")[0]?.payload).toMatchObject({
      scopeKind: "loopback-port",
      decisionSource: "review-model",
      outcome: "allow",
    });
    const [r] = await results();
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    expect((await grants())[0]).toMatchObject({ source: "review-model", attempt: 1 });
    expect(await asks()).toEqual([]);
  });

  it("a rule's allow on the review path is recorded as the rule's", async () => {
    await profile("approve-for-me");
    vi.spyOn(k.app.get(CommandReviewService), "reviewLoopbackPort").mockResolvedValue({
      decision: "allow",
      by: "rule",
      rule: "test-rule",
      reason: "A rule allowed it.",
      approver: "review-model",
    });
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const evs = await eventsOf(db, s.conversationId);
    expect(ofType(evs, "permission_reviewed")[0]?.payload).toMatchObject({
      scopeKind: "loopback-port",
      decisionSource: "rule",
      outcome: "allow",
    });
    expect((await grants())[0]).toMatchObject({ source: "review-model", attempt: 1 });
  });

  it("asks the person when the review model answers ask", async () => {
    await profile("approve-for-me");
    vi.spyOn(k.app.get(CommandReviewService), "reviewLoopbackPort").mockResolvedValue({
      decision: "ask",
      by: "classifier",
      rule: null,
      reason: "The browser asks to reach port 3999 on this device. Review: not sure.",
      approver: "review-model",
    });
    await navigate();
    const ask = await nextAsk();
    expect(ask).toMatchObject({ scopes: ["session"], requested_for: s.accountId });
    expect(ask.detail).toMatchObject({ kind: "loopback", port: 3999, attempt: 1 });
    const evs = await eventsOf(db, s.conversationId);
    expect(ofType(evs, "permission_reviewed")[0]?.payload).toMatchObject({
      outcome: "ask",
      decisionSource: "review-model",
    });
    expect(await grants()).toEqual([]);
  });

  it("the review model's deny writes the review's note; nothing is granted", async () => {
    await profile("approve-for-me");
    vi.spyOn(k.app.get(CommandReviewService), "reviewLoopbackPort").mockResolvedValue({
      decision: "deny",
      by: "classifier",
      rule: null,
      reason: "Nothing in the conversation asks for this port.",
      approver: "review-model",
    });
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = await results();
    expect(r?.content).toContain(`Could not load ${URL_3999}.`);
    expect(r?.content).toContain(
      loopbackReviewDeniedNote(3999, "Nothing in the conversation asks for this port."),
    );
    expect(invocations()).toEqual([1]);
    expect(await grants()).toEqual([]);
    expect(await asks()).toEqual([]);
  });

  it("a sub-agent's ask goes to the review model under full access", async () => {
    await profile("full-access");
    const review = vi
      .spyOn(k.app.get(CommandReviewService), "reviewLoopbackPort")
      .mockResolvedValue({
        decision: "allow",
        by: "classifier",
        rule: null,
        reason: "The parent asked to open the dev server.",
        approver: "review-model",
      });
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:Agent:${JSON.stringify({
        description: "Open",
        prompt: `tool:${NAVIGATE}:${navigateInput()}`,
        subagent_type: "general-purpose",
      })}`,
    );
    const child = await waitFor(
      async () =>
        (
          await db
            .selectFrom("conversations")
            .select("id")
            .where("parent_conversation_id", "=", s.conversationId)
            .executeTakeFirst()
        )?.id,
      30_000,
      "the sub-agent's conversation",
    );
    await waitFor(async () => (await results(child)).length > 0, 30_000, "the child's result");
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0]?.[0]).toMatchObject({ profile: "full-access", port: 3999 });
    expect(review.mock.calls[0]?.[0].parentRunId).toBeDefined();
    const [r] = await results(child);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    // the root holds the grant
    expect((await grants())[0]).toMatchObject({
      source: "review-model",
      conversation_id: s.conversationId,
    });
  });

  it("request-approval asks the device owner; approval grants and reruns", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    expect(ask).toMatchObject({
      tool_key: NAVIGATE,
      scopes: ["session"],
      requested_for: s.accountId,
    });
    expect(ask.detail).toMatchObject({
      kind: "loopback",
      deviceId: s.deviceId,
      service: SERVICE_ID,
      url: URL_3999,
      port: 3999,
      database: false,
      attempt: 1,
    });
    const evs = await eventsOf(db, s.conversationId);
    const requested = ofType(evs, "approval_requested")[0]?.payload;
    expect(requested).toMatchObject({
      toolKey: NAVIGATE,
      loopback: { service: SERVICE_ID, port: 3999, database: false },
    });
    expect(requested).not.toHaveProperty("network");
    expect(await results()).toEqual([]);
    // only "session", and no hosts
    expect((await decide(ask.id, { decision: "approve", scope: "once" })).statusCode).toBe(409);
    expect(
      (await decide(ask.id, { decision: "approve", scope: "session", hosts: ["127.0.0.1"] }))
        .statusCode,
    ).toBe(400);
    const res = await decide(ask.id, { decision: "approve", scope: "session" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: { detail: unknown } }).approval.detail).toMatchObject({
      kind: "loopback",
      outcome: "session",
    });
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect((await grants())[0]).toMatchObject({
      source: "human",
      approval_id: ask.id,
      attempt: 1,
      conversation_id: s.conversationId,
    });
    const [r] = await results();
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    expect(invocations()).toEqual([2]);
    expect(await startedAttempts()).toEqual([1, 2]);
  });

  it("an approval the device can no longer take keeps the ask pending", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    supportOverride((sup) => ({ ...sup, network: { ...sup.network, loopbackPorts: false } }));
    const res = await decide(ask.id, { decision: "approve", scope: "session" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "approval.loopback_unavailable",
    );
    expect((await asks())[0]?.status).toBe("pending");
    expect(await grants()).toEqual([]);
  });

  it("deny leaves the call failed with the not-approved note", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    const res = await decide(ask.id, { decision: "deny", reason: "Not now." });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = await results();
    expect(r?.content).toContain(`Could not load ${URL_3999}.`);
    expect(r?.content.endsWith(`\n\n${loopbackDeniedNote(3999, "Not now.")}`)).toBe(true);
    expect(invocations()).toEqual([1]);
    expect(await grants()).toEqual([]);
  });

  it("expiry writes the expired note", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    await sql`UPDATE capybara.approvals SET created_at = now() - interval '24 hours',
      expires_at = now() - interval '1 second' WHERE id = ${ask.id}`.execute(raw);
    await k.app.get(Waits).expire("approval", ask.id);
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = await results();
    expect(r?.content.endsWith(`\n\n${loopbackExpiredNote(3999, 24)}`)).toBe(true);
    expect(await grants()).toEqual([]);
  });

  describe("refuses with a note when outside-sandbox is off, an unattended run, or the provider lacks support", () => {
    it("the org's outside-sandbox setting is off", async () => {
      await profile("full-access");
      const before = await db
        .selectFrom("orgs")
        .select("settings")
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow();
      await k.app.get(OrgSettingsService).update(orgId, { outsideSandbox: "off" }, ownerId);
      try {
        await navigate();
        await waitForTerminal(db, s.conversationId, 1, 30_000);
      } finally {
        await db
          .updateTable("orgs")
          .set({ settings: JSON.stringify(before.settings) })
          .where("id", "=", orgId)
          .execute();
      }
      const [r] = await results();
      expect(r?.content).toContain(
        "[network] 127.0.0.1:3999 is a local port on the device. Local ports stay closed to the browser because running outside the sandbox is not possible here (",
      );
      expect(r?.content).toMatch(/organization/);
      expect(r?.content).not.toContain('sandbox: "escalated"');
      expect(await asks()).toEqual([]);
      expect(await grants()).toEqual([]);
    });

    it("an unattended run", async () => {
      await profile("full-access");
      const authority = k.app.get(SandboxOperationAuthority);
      const original = authority.previewCall.bind(authority);
      vi.spyOn(authority, "previewCall").mockImplementation(async (...args) => ({
        ...(await original(...args)),
        unattended: true,
        profile: "request-approval",
        escalationRefusal: ESCALATION_UNATTENDED_WHY,
      }));
      await navigate();
      await waitForTerminal(db, s.conversationId, 1, 30_000);
      const [r] = await results();
      expect(r?.content).toContain(
        `Local ports stay closed to the browser because running outside the sandbox is not possible here (${ESCALATION_UNATTENDED_WHY}).`,
      );
      expect(await asks()).toEqual([]);
      expect(await grants()).toEqual([]);
    });

    it("an automation's conversation, by the kernel's own records", async () => {
      await profile("full-access");
      await unattended();
      await navigate();
      await waitForTerminal(db, s.conversationId, 1, 30_000);
      const [r] = await results();
      expect(r?.content).toContain(
        `Local ports stay closed to the browser because running outside the sandbox is not possible here (${ESCALATION_UNATTENDED_WHY}).`,
      );
      expect(await startedAttempts()).toEqual([1]);
      expect(ofType(await eventsOf(db, s.conversationId), "permission_reviewed")).toEqual([]);
      expect(await asks()).toEqual([]);
      expect(await grants()).toEqual([]);
    });

    it("an unattended run is not approved by a live grant of the tree", async () => {
      await profile("full-access");
      // the person granted the port from the panel earlier
      await k.app.get(TransactionHost).run(() =>
        k.app.get(LoopbackGrants).grantIn(
          {
            orgId,
            deviceId: s.deviceId,
            serviceId: SERVICE_ID,
            rootConversationId: s.conversationId,
            port: 3999,
          },
          { source: "owner-panel", actorAccountId: s.accountId },
        ),
      );
      await unattended();
      await navigate();
      await waitForTerminal(db, s.conversationId, 1, 30_000);
      const [r] = await results();
      expect(r?.content).toContain(
        `Local ports stay closed to the browser because running outside the sandbox is not possible here (${ESCALATION_UNATTENDED_WHY}).`,
      );
      // no rerun on the live grant, and nothing new granted
      expect(await startedAttempts()).toEqual([1]);
      expect(invocations()).toEqual([1]);
      const [g, ...others] = await grants();
      expect(others).toEqual([]);
      expect(g).toMatchObject({ source: "owner-panel", revoked_at: null });
      expect(await asks()).toEqual([]);
    });

    it("the provider lacks support", async () => {
      await profile("full-access");
      supportOverride((sup) => ({ ...sup, network: { ...sup.network, loopbackPorts: false } }));
      await navigate();
      await waitForTerminal(db, s.conversationId, 1, 30_000);
      const [r] = await results();
      expect(r?.content).toContain(
        "Local ports stay closed to the browser because this device's provider cannot open a local port to a device service.",
      );
      expect(r?.content).toContain(
        'A command run outside the sandbox (Bash with sandbox: "escalated") still reaches it.',
      );
      expect(await asks()).toEqual([]);
      expect(await grants()).toEqual([]);
    });
  });

  it("notes an outdated device", async () => {
    await profile("full-access");
    supportOverride((sup) => ({
      ...sup,
      network: { ...sup.network, loopbackPorts: false },
      limitedBy: { ...sup.limitedBy, loopbackPorts: "device-update" },
    }));
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = await results();
    expect(r?.content).toContain("update capybara-device");
    expect(await grants()).toEqual([]);
  });

  it("an extension not declaring loopbackPorts keeps today's address note", async () => {
    await profile("full-access");
    const access = k.app.get(DeviceAccessService);
    const original = access.reportBlockedHosts.bind(access);
    vi.spyOn(access, "reportBlockedHosts").mockImplementation((caller, ...rest) =>
      original({ ...caller, loopbackPorts: false }, ...rest),
    );
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = await results();
    expect(r?.content).toContain(`Could not load ${URL_3999}.`);
    expect(r?.content).toContain(addressLayerNote(["127.0.0.1"]).slice(0, 60));
    expect(ofType(await eventsOf(db, s.conversationId), "permission_reviewed")).toEqual([]);
    expect(await asks()).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  it("a re-run that asks a network ask of its own resumes from that ask and runs again", async () => {
    await profile("full-access");
    // the port is granted, and the page then loads a CDN host the device's list does not hold
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${NAVIGATE}:${navigateInput(URL_3999, ["cdn.example.org"])}`,
    );
    const ask = await nextAsk();
    expect(ask.detail).toMatchObject({ kind: "service", hosts: ["cdn.example.org"], attempt: 2 });
    const res = await decide(ask.id, { decision: "approve", scope: "always" });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect(await startedAttempts()).toEqual([1, 2, 3]);
    const [r, ...rest] = await results();
    expect(rest).toEqual([]);
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).not.toContain("Result unknown");
    expect(invocations()).toEqual([3]);
  });

  it("an approved ask reruns the call even when the panel granted the port first", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    // the panel's grant, written as the panel writes it (not tied to the call)
    await k.app.get(TransactionHost).run(() =>
      k.app.get(LoopbackGrants).grantIn(
        {
          orgId,
          deviceId: s.deviceId,
          serviceId: SERVICE_ID,
          rootConversationId: s.conversationId,
          port: 3999,
        },
        { source: "owner-panel", actorAccountId: s.accountId },
      ),
    );
    const res = await decide(ask.id, { decision: "approve", scope: "session" });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect(await startedAttempts()).toEqual([1, 2]);
    const [r] = await results();
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    const [g, ...others] = await grants();
    expect(others).toEqual([]);
    expect(g).toMatchObject({ source: "owner-panel", call_id: null });
  });

  it("a panel grant of the same port settles the pending ask; the call reruns", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    await k.app.get(DeviceAccessService).grantLoopbackPort(
      { extension: "fake-device-access", services: ["echo"], loopbackPorts: true },
      {
        orgId,
        accountId: s.accountId,
        conversationId: s.conversationId,
        service: "echo",
        port: 3999,
      },
    );
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect((await asks()).find((a) => a.id === ask.id)?.status).toBe("approved");
    expect(await startedAttempts()).toEqual([1, 2]);
    const [r] = await results();
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect((await grants())[0]).toMatchObject({ source: "owner-panel" });
  });

  it("an input round after two re-runs resumes in the attempt after them, with the answer", async () => {
    await profile("full-access");
    // attempt 1: the port is granted; attempt 2: a CDN host is asked about and approved;
    // attempt 3 asks an input round; its answer runs attempt 4
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${NAVIGATE}:${navigateInput(URL_3999, ["cdn.example.org"], true)}`,
    );
    const ask = await nextAsk();
    expect((await decide(ask.id, { decision: "approve", scope: "always" })).statusCode).toBe(200);
    const question = await waitFor(
      async () =>
        (
          await db
            .selectFrom("questions")
            .select(["id", "status"])
            .where("conversation_id", "=", s.conversationId)
            .executeTakeFirst()
        )?.id,
      30_000,
      "the input round",
    );
    const res = await s.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${question}/answer`,
      payload: { answer: { done: true } },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect(await startedAttempts()).toEqual([1, 2, 3, 4]);
    const [r, ...rest] = await results();
    expect(rest).toEqual([]);
    expect(r?.content).toContain("done: true");
    expect(r?.content).not.toContain("Result unknown");
  });

  it("a panel grant revoked before the settle leaves the ask pending and the port closed", async () => {
    await profile("request-approval");
    await navigate();
    const ask = await nextAsk();
    const key = {
      orgId,
      deviceId: s.deviceId,
      serviceId: SERVICE_ID,
      rootConversationId: s.conversationId,
      port: 3999,
    };
    const grantsService = k.app.get(LoopbackGrants);
    await k.app
      .get(TransactionHost)
      .run(() =>
        grantsService.grantIn(key, { source: "owner-panel", actorAccountId: s.accountId }),
      );
    // revoked from another surface before the panel's settle runs
    expect(await grantsService.revoke(key, s.accountId)).toBe(true);
    const settled = await k.app.get(ApprovalsService).settleLoopbackAsks(orgId, s.accountId, key);
    expect(settled.approved).toBe(0);
    expect(settled.failed.map((f) => (f.err as { code?: string }).code)).toEqual([
      "approval.loopback_unavailable",
    ]);
    expect((await asks()).find((a) => a.id === ask.id)?.status).toBe("pending");
    expect(
      await grantsService.liveForRoot(orgId, s.deviceId, SERVICE_ID, s.conversationId),
    ).toEqual([]);
    expect((await grants()).every((g) => g.revoked_at !== null)).toBe(true);
  });

  it("resumes a granted call as the rerun after a crash", async () => {
    await profile("full-access");
    // the replica loses the run right after the grant committed, before the re-run started: the
    // run is taken up again and must run the call again in attempt 2, not write "result unknown"
    const pipeline = k.app.get(ToolPipeline) as unknown as {
      runCall: (...args: unknown[]) => Promise<unknown>;
    };
    const original = pipeline.runCall;
    let crashed = false;
    vi.spyOn(pipeline, "runCall").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args[3] === 2 && !crashed) {
        crashed = true;
        return Promise.reject(new ExecutionRevoked());
      }
      return original.apply(this, args);
    });
    await navigate();
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    expect(crashed).toBe(true);
    expect(await startedAttempts()).toEqual([1, 2]);
    const [r, ...rest] = await results();
    expect(rest).toEqual([]);
    expect(r?.content).toContain(`Loaded ${URL_3999}.`);
    expect(r?.content).toContain(loopbackGrantedNote(3999));
    expect(await grants()).toHaveLength(1);
  });
});
