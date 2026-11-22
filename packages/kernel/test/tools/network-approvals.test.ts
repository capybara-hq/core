import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { Waits } from "../../src/runtime/waits.js";
import { instanceLimitsJson } from "../../src/sandbox/modes.js";
import { NetworkGrants } from "../../src/sandbox/network-grants.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  type ApprovalRecord,
  ApprovalsService,
  NETWORK_ASK_CANCELLED_NOTE,
  type NetworkAskInput,
} from "../../src/tools/approvals.service.js";
import {
  deviceAskTerms,
  onListNote,
  planNetworkAsk,
  settledNetworkNotes,
  withNetworkNotes,
} from "../../src/tools/network-asks.js";
import {
  FAKE_INSTANCE_PERMISSION_SUPPORT,
  FAKE_PERMISSION_SUPPORT,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Network asks (network ask-to-allow spec §5.2, §6.1–§6.8, P1.6; device-provider spec §6.3):
 * approvals of kind `network` the device owner decides, offering what the device's provider
 * enforces. "Allow this time" is a run grant, offered only with per-operation hosts; "Add to this
 * device's list" adds the hosts to the device's own network list (no run grant, the command is
 * not run again), applying from the next command, the next use, or after the files are rebuilt
 * (a `device-fake` with `limitsApplyAt: "fileSystem"` here). A reply skips the ask, expiry and
 * abort settle it, and the call's tool approvals are left alone.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let owner: Req;
let sandboxRoot: string;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-network-approvals-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  // no worker: a resumed run is enqueued and stays queued
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "gateway"],
        // limits fixed at the file system: a host added to a device's list waits for a files reset
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot, limitsApplyAt: "fileSystem" } },
        devices: { dialIn: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  // the org's effective hosts take a.dev and b.dev; x.dev stays outside them
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { deviceNetwork: { extraHosts: ["a.dev", "b.dev"] } },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const approvals = () => k.app.get(ApprovalsService);

/** A member with a session, a device of their own and a conversation. */
interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  conversationId: string;
  runId: string;
}

let s: Setup;

beforeEach(async () => {
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
    })
    .execute();
  const device = { deviceId };
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  const runId = await run(conversationId, accountId);
  s = { accountId, req, ...device, conversationId, runId };
});

/** A waiting run of `conversationId` started by `accountId`. */
async function run(conversationId: string, accountId: string, budgetRunId: string | null = null) {
  const id = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, budget_run_id, waiting_since)
    VALUES (${id}, ${conversationId}, 'waiting', 1, ${accountId}, 0, ${budgetRunId}, now())`.execute(
    raw,
  );
  return id;
}

const KEPT = { content: "curl: (56) CONNECT tunnel failed, response 403", isError: true };

function ask(over: Partial<NetworkAskInput> = {}): Promise<ApprovalRecord> {
  return approvals().requestNetwork({
    orgId,
    conversationId: s.conversationId,
    runId: s.runId,
    step: 1,
    callId: `c-${randomUUID().slice(0, 8)}`,
    requestedFor: s.accountId,
    detail: {
      deviceId: s.deviceId,
      hosts: [
        { host: "files.slack.com", port: 443 },
        { host: "api.github.com", port: 443 },
      ],
      command: "curl https://files.slack.com/x",
      description: "Download the file",
      appliesAt: "next-command",
      result: KEPT,
    },
    scopes: ["once"],
    ...over,
  });
}

const decide = (id: string, payload: Record<string, unknown>, req: Req = s.req) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const row = (id: string) =>
  db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const runStatus = async (runId: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow())
    .status;

const networkAudits = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "in", [
      "device.policy_changed",
      "device.network_allowed",
      "device.network_denied",
    ])
    .orderBy("id")
    .execute();

describe("requestNetwork", () => {
  it("records a pending network ask for the device owner and logs approval_requested with the hosts", async () => {
    const a = await ask();
    expect(a).toMatchObject({
      kind: "network",
      status: "pending",
      toolKey: "Bash",
      attempt: 1,
      requestedFor: s.accountId,
      approverRole: null,
      scopes: ["once"],
      detail: { deviceId: s.deviceId, result: KEPT },
    });
    const [requested] = ofType(await eventsOf(db, s.conversationId), "approval_requested");
    expect(requested?.payload).toEqual({
      step: 1,
      callId: a.callId,
      approvalId: a.id,
      toolKey: "Bash",
      expiresAt: a.expiresAt,
      network: { hosts: ["files.slack.com", "api.github.com"] },
      requestedFor: s.accountId,
      approverRole: null,
    });
    // expires like a tool approval (tools.approvalTimeoutHours, 24h by default)
    const hours = (new Date(a.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("takes the attempt after the call's tool approvals; forCall sees only tool approvals; one ask per call", async () => {
    const callId = "c-shared";
    const tool = await approvals().request({
      orgId,
      conversationId: s.conversationId,
      runId: s.runId,
      step: 1,
      callId,
      toolKey: "Bash",
      specHash: "h",
      connectorId: null,
      input: { command: "curl x" },
      requestedFor: s.accountId,
      approverRole: null,
    });
    const net = await ask({ callId });
    expect(net.attempt).toBe(2);
    expect(await ask({ callId })).toMatchObject({ id: net.id });
    expect((await approvals().forCall(s.runId, callId))?.id).toBe(tool.id);
    expect((await approvals().networkForCall(s.runId, callId))?.id).toBe(net.id);
    expect(await approvals().networkForCall(s.runId, "c-none")).toBeNull();
    // deciding the network ask leaves the tool approval as it was
    expect((await decide(net.id, { decision: "deny" })).statusCode).toBe(200);
    expect((await approvals().forCall(s.runId, callId))?.status).toBe("pending");
  });
});

describe("decide", () => {
  it("「这次允许」: a run grant of every asked host, approval_decided, device.network_allowed, the run resumes", async () => {
    const a = await ask();
    const res = await decide(a.id, { decision: "approve", scope: "once" });
    expect(res.statusCode, res.body).toBe(200);
    const body = (res.json() as { approval: Record<string, unknown> }).approval;
    expect(body).toMatchObject({ status: "approved", scope: "once", kind: "network" });
    // the kept command result never leaves the kernel
    expect(body.detail).not.toHaveProperty("result");
    expect((await row(a.id)).detail).toMatchObject({
      grantedHosts: ["files.slack.com", "api.github.com"],
      outcome: "once",
      result: KEPT,
    });
    const grants = await k.app
      .get(NetworkGrants)
      .forExec({ orgId, runId: s.runId, deviceId: s.deviceId });
    expect([...(grants?.hosts ?? [])].sort()).toEqual(["api.github.com", "files.slack.com"]);
    const [decided] = ofType(await eventsOf(db, s.conversationId), "approval_decided");
    expect(decided?.payload).toEqual({
      approvalId: a.id,
      callId: a.callId,
      decision: "approved",
      scope: "once",
      byAccountId: s.accountId,
    });
    expect(await networkAudits(s.deviceId)).toEqual([
      {
        action: "device.network_allowed",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({
          approvalId: a.id,
          deviceId: s.deviceId,
          hosts: ["files.slack.com", "api.github.com"],
          scope: "once",
          outcome: "once",
          by: s.accountId,
          via: "web",
        }),
      },
    ]);
    // no tool grant of any kind
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("conversation_tool_grants").selectAll().execute()).toEqual([]);
    await waitFor(async () => (await runStatus(s.runId)) === "queued", 10_000, "run resumed");
  });

  it("deny: a reason, device.network_denied, nothing granted, the hosts refused in the run", async () => {
    const a = await ask();
    const res = await decide(a.id, { decision: "deny", reason: "Not this one" });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      await k.app.get(NetworkGrants).forExec({ orgId, runId: s.runId, deviceId: s.deviceId }),
    ).toBeUndefined();
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect([...state.refused].sort()).toEqual(["api.github.com", "files.slack.com"]);
    const audits = await networkAudits(s.deviceId);
    expect(audits).toEqual([
      {
        action: "device.network_denied",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({
          hosts: ["files.slack.com", "api.github.com"],
          outcome: "denied",
          scope: null,
          reason: "Not this one",
        }),
      },
    ]);
  });
});

/**
 * A device of the setup's member on `device-fake` with a host list of its own (a.dev) and the
 * provider support stored with its report: `FAKE_INSTANCE_PERMISSION_SUPPORT` is list-only (an
 * instance boundary), `FAKE_PERMISSION_SUPPORT` gives per-operation hosts.
 */
async function ownListDevice(support: SandboxPermissionSupport): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: s.accountId,
      name: `Box ${id.slice(0, 4)}`,
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify(["a.dev"]),
      report: JSON.stringify({ support }),
    })
    .execute();
  return id;
}

/**
 * A network ask about `hosts` on `deviceId`, offering what the pipeline offers there (the device's
 * sandbox facts through `deviceAskTerms`, as `networkBlocked` reads them).
 */
async function blockedAsk(deviceId: string, hosts: string[]): Promise<ApprovalRecord> {
  const terms = deviceAskTerms(await k.app.get(SandboxService).hostRefusal({ orgId, deviceId }));
  for (const h of hosts) expect(terms.refusal(h)).toBeNull();
  const offer = terms.offer(hosts);
  if (offer === null) throw new Error(`nothing to offer for ${hosts.join(", ")}`);
  return ask({
    detail: {
      deviceId,
      hosts: hosts.map((host) => ({ host, port: 443 })),
      command: `curl ${hosts.join(" ")}`,
      description: null,
      appliesAt: offer.appliesAt,
      result: KEPT,
    },
    scopes: offer.scopes,
  });
}

const deviceView = async (deviceId: string) =>
  (
    (await s.req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices/${deviceId}` })).json() as {
      device: {
        sandbox: {
          allowedDomains: string[];
          pendingFilesReset: boolean;
          recent: { via?: string }[];
        };
      };
    }
  ).device;

const runGrantsOf = async (runId: string, deviceId: string) => [
  ...((await k.app.get(NetworkGrants).forExec({ orgId, runId, deviceId }))?.hosts ?? []),
];

/** The kept result the resumed run writes for the decided ask (the pipeline's settle note). */
const keptResultOf = async (a: ApprovalRecord) =>
  withNetworkNotes(
    KEPT.content,
    settledNetworkNotes(
      (await approvals().get(orgId, a.id, s.accountId)) as unknown as ApprovalRecord,
      24,
    ) ?? [],
  );

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe("what an ask offers (device-provider spec §6.3)", () => {
  it("always on a fileSystem provider: appliesAt files-reset, hosts stored, pendingFilesReset", async () => {
    const device = await ownListDevice(FAKE_INSTANCE_PERMISSION_SUPPORT);
    // a file system made with the device's current limits: nothing pending yet
    const { effective } = await k.app.get(SandboxService).limitsState({ orgId, deviceId: device });
    await sql`INSERT INTO capybara.device_instances (device_id, org_id, provider, status, handle,
        fs_status, fs_handle, instance_limits)
      VALUES (${device}, ${orgId}, 'device-fake', 'suspended',
        ${JSON.stringify({ id: "fake-i" })}::jsonb, 'ready', ${JSON.stringify({ id: "fs-i" })}::jsonb,
        ${instanceLimitsJson(effective)}::jsonb)`.execute(raw);
    expect((await deviceView(device)).sandbox.pendingFilesReset).toBe(false);
    const a = await blockedAsk(device, ["b.dev"]);
    expect(a.scopes).toEqual(["always"]);
    expect(a.detail?.appliesAt).toBe("files-reset");
    const res = await decide(a.id, { decision: "approve", scope: "always" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: Record<string, unknown> }).approval).toMatchObject({
      status: "approved",
      scope: "always",
      detail: { appliesAt: "files-reset", outcome: "always", grantedHosts: ["b.dev"] },
    });
    const d = await deviceView(device);
    expect(d.sandbox.allowedDomains).toEqual(["a.dev", "b.dev"]);
    expect(d.sandbox.pendingFilesReset).toBe(true);
    // no run grant: the command that asked never gets the host, and is not run again
    expect(await runGrantsOf(a.runId, device)).toEqual([]);
    expect(await keptResultOf(a)).toMatch(
      /added b\.dev to this device's network list.*after the files are rebuilt\. This command is not run again\.$/i,
    );
    expect(await networkAudits(device)).toEqual([
      {
        action: "device.network_allowed",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({ hosts: ["b.dev"], scope: "always", outcome: "always" }),
      },
    ]);
    await waitFor(async () => (await runStatus(s.runId)) === "queued", 10_000, "run resumed");
    // blocked again in the same run before the files are rebuilt: not asked again, told when
    const terms = deviceAskTerms(
      await k.app.get(SandboxService).hostRefusal({ orgId, deviceId: device }),
    );
    const again = planNetworkAsk(
      [{ host: "b.dev", port: 443, layer: "device" }],
      await k.app.get(NetworkGrants).runState(a.runId, device),
      { unattended: null, ...terms },
    );
    expect(again.ask).toEqual([]);
    expect(again.notes).toEqual([onListNote(["b.dev"], "files-reset")]);
  });

  // the device write is the decision's prelude: a widening locks the device's Full access roots
  // before any conversation row, so a cascade that locks a root and then its sub-agent's
  // conversation (offboarding, a sub-agent cancel) never deadlocks with it
  it("a sub-agent asks under a Full access root on the device: the root is locked before the asking conversation", async () => {
    const device = await ownListDevice(FAKE_PERMISSION_SUPPORT);
    await sql`UPDATE capybara.conversations SET device_id = ${device},
        permission_profile = 'full-access',
        permission_consent = ${JSON.stringify({ deviceId: device, scopeRevision: "test" })}::jsonb
      WHERE id = ${s.conversationId}`.execute(raw);
    const childConv = await subagentConversation();
    const childRun = await run(childConv, s.accountId, s.runId);
    const terms = deviceAskTerms(
      await k.app.get(SandboxService).hostRefusal({ orgId, deviceId: device }),
    );
    const offer = terms.offer(["b.dev"]);
    if (offer === null) throw new Error("nothing to offer");
    const a = await ask({
      conversationId: childConv,
      runId: childRun,
      detail: {
        deviceId: device,
        hosts: [{ host: "b.dev", port: 443 }],
        command: "curl b.dev",
        description: null,
        appliesAt: offer.appliesAt,
        result: KEPT,
      },
      scopes: offer.scopes,
    });
    // a cascade holds the root first
    const cascade = await raw.connection().execute(async (c) => {
      await sql`BEGIN`.execute(c);
      await sql`SELECT id FROM capybara.conversations WHERE id = ${s.conversationId} FOR UPDATE`.execute(
        c,
      );
      const decision = decide(a.id, { decision: "approve", scope: "always" });
      // the decision waits on the root ...
      await waitFor(
        async () =>
          (
            await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query ILIKE '%conversations%'`.execute(raw)
          ).rows[0]?.n === 1,
        10_000,
        "the decision waits on the root conversation",
      );
      // ... without holding the sub-agent's conversation, which the cascade takes next
      await sql`SELECT id FROM capybara.conversations WHERE id = ${childConv} FOR UPDATE NOWAIT`.execute(
        c,
      );
      await sql`COMMIT`.execute(c);
      return decision;
    });
    expect(cascade.statusCode, cascade.body).toBe(200);
    expect((await deviceView(device)).sandbox.allowedDomains).toEqual(["a.dev", "b.dev"]);
    // the widening reset the root's Full access consent
    expect(
      (
        await db
          .selectFrom("conversations")
          .select("permission_profile")
          .where("id", "=", s.conversationId)
          .executeTakeFirstOrThrow()
      ).permission_profile,
    ).toBe("approve-for-me");
  });

  it("once on a list-only device → 409 approval.scope_not_allowed", async () => {
    const device = await ownListDevice(FAKE_INSTANCE_PERMISSION_SUPPORT);
    const a = await blockedAsk(device, ["b.dev"]);
    for (const payload of [{ decision: "approve", scope: "once" }, { decision: "approve" }]) {
      const res = await decide(a.id, payload);
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe("approval.scope_not_allowed");
    }
    expect((await row(a.id)).status).toBe("pending");
    expect((await deviceView(device)).sandbox.allowedDomains).toEqual(["a.dev"]);
  });

  it("always on a per-operation device adds the host and the run grant is not written", async () => {
    const dialInDevice = await ownListDevice(FAKE_PERMISSION_SUPPORT);
    const a = await blockedAsk(dialInDevice, ["b.dev"]);
    expect(a.scopes).toEqual(["once", "always"]);
    expect(a.detail?.appliesAt).toBe("next-command");
    // decided from IM: the device's change says so
    await approvals().decide(
      orgId,
      a.id,
      s.accountId,
      { decision: "approve", scope: "always" },
      undefined,
      "im",
    );
    const d = await deviceView(dialInDevice);
    expect(d.sandbox.allowedDomains).toEqual(["a.dev", "b.dev"]);
    expect(d.sandbox.recent[0]).toMatchObject({ via: "im" });
    expect(await runGrantsOf(a.runId, dialInDevice)).toEqual([]);
    expect(await keptResultOf(a)).toMatch(/it applies from the next command\./);
  });

  it("a host outside the org's effective hosts is never offered add to this device's list", async () => {
    const list = deviceAskTerms(
      await k.app.get(SandboxService).hostRefusal({
        orgId,
        deviceId: await ownListDevice(FAKE_INSTANCE_PERMISSION_SUPPORT),
      }),
    );
    expect(list.refusal("x.dev")).toContain("an organization admin adds x.dev");
    const perOp = deviceAskTerms(
      await k.app.get(SandboxService).hostRefusal({
        orgId,
        deviceId: await ownListDevice(FAKE_PERMISSION_SUPPORT),
      }),
    );
    expect(perOp.offer(["x.dev"])?.scopes ?? []).not.toContain("always");
    expect(perOp.offer(["b.dev", "x.dev"])?.scopes ?? []).not.toContain("always");
  });

  it("a device following its org's hosts offers no always; a list-only one has nothing to offer", async () => {
    const device = await ownListDevice(FAKE_PERMISSION_SUPPORT);
    await sql`UPDATE capybara.devices SET network_mode = NULL, network_hosts = '[]'::jsonb
      WHERE id = ${device}`.execute(raw);
    const terms = deviceAskTerms(
      await k.app.get(SandboxService).hostRefusal({ orgId, deviceId: device }),
    );
    expect(terms.offer(["b.dev"])?.scopes).toEqual(["once"]);
    const listOnly = await ownListDevice(FAKE_INSTANCE_PERMISSION_SUPPORT);
    await sql`UPDATE capybara.devices SET network_mode = NULL, network_hosts = '[]'::jsonb
      WHERE id = ${listOnly}`.execute(raw);
    expect(
      deviceAskTerms(
        await k.app.get(SandboxService).hostRefusal({ orgId, deviceId: listOnly }),
      ).offer(["b.dev"]),
    ).toBeNull();
  });
});

/** A sub-agent's conversation under the setup's conversation. */
async function subagentConversation(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
    SELECT ${id}, org_id, agent_id, account_id, 'subagent', id
      FROM capybara.conversations WHERE id = ${s.conversationId}`.execute(raw);
  return id;
}

describe("settling without a decision", () => {
  it("a reply by the run's starter skips the asks here and in a sub-agent's conversation; the runs resume", async () => {
    const here = await ask();
    // a sub-agent's conversation and run (its trigger account is the person's, as dispatched)
    const childConv = await subagentConversation();
    const childRun = await run(childConv, s.accountId, s.runId);
    const child = await ask({ conversationId: childConv, runId: childRun });
    // another person's run in a sub-agent's conversation is not theirs to skip
    const strangerConv = await subagentConversation();
    const strangerRun = await run(strangerConv, ownerId);
    const stranger = await ask({ conversationId: strangerConv, runId: strangerRun });

    await postMessage(s.req, orgId, s.conversationId, "never mind, use the cache");

    for (const [id, conv] of [
      [here.id, s.conversationId],
      [child.id, childConv],
    ] as const) {
      expect((await row(id)).status).toBe("skipped");
      const decided = ofType(await eventsOf(db, conv), "approval_decided").find(
        (e) => e.payload.approvalId === id,
      );
      expect(decided?.payload).toEqual({
        approvalId: id,
        callId: expect.any(String),
        decision: "skipped",
        byAccountId: s.accountId,
      });
    }
    expect((await row(stranger.id)).status).toBe("pending");
    await waitFor(async () => (await runStatus(s.runId)) === "queued", 10_000, "run resumed");
    await waitFor(async () => (await runStatus(childRun)) === "queued", 10_000, "child resumed");
    // a skipped host is not asked again in the run tree
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect(state.refused.has("files.slack.com")).toBe(true);
    // a skipped ask is no longer decidable
    const late = await decide(here.id, { decision: "approve" });
    expect(late.statusCode).toBe(409);
  });

  it("expiry: the wait timeout expires the ask like a tool approval", async () => {
    const a = await ask();
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second'
      WHERE id = ${a.id}`.execute(raw);
    await k.app.get(Waits).expire("approval", a.id);
    expect((await row(a.id)).status).toBe("expired");
    const decided = ofType(await eventsOf(db, s.conversationId), "approval_decided");
    expect(decided.map((e) => e.payload.decision)).toEqual(["expired"]);
    const late = await decide(a.id, { decision: "approve" });
    expect(late.statusCode).toBe(409);
  });

  it("abort: the call's result is the kept command result plus the cancelled note", async () => {
    const callId = "c-abort";
    await k.app.get(EventLog).append(s.conversationId, [
      {
        type: "assistant_message",
        runId: s.runId,
        idemKey: assistantIdemKey(s.runId, 1),
        payload: {
          step: 1,
          content: [{ type: "tool_call", id: callId, name: "Bash", input: { command: "curl x" } }],
          stopReason: "tool_use",
        },
      },
    ]);
    const a = await ask({ callId });
    expect(await k.app.get(Waits).abortWaiting(s.conversationId, s.runId, s.accountId)).toBe(true);
    expect((await row(a.id)).status).toBe("cancelled");
    const [result] = ofType(await eventsOf(db, s.conversationId), "tool_result");
    expect(result?.payload).toMatchObject({
      callId,
      toolKey: "Bash",
      content: `${KEPT.content}\n\n${NETWORK_ASK_CANCELLED_NOTE}`,
      isError: true,
    });
  });
});
