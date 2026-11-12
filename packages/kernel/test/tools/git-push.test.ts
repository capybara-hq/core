import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { UnattendedRun } from "../../src/schedules/unattended.js";
import {
  type ApprovalRecord,
  type ApprovalsService,
  type GitAskInput,
  publicRecord,
} from "../../src/tools/approvals.service.js";
import { decideGitPush, gitRunState } from "../../src/tools/git-push-policy.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { eventsOf } from "../helpers/runs.js";
import { seedConnector, seedConversation } from "../helpers/tool-fixtures.js";
import { approvalsFor, configFrom } from "../helpers/tools.js";

/**
 * Git push policy and asks (sandbox git credentials spec §7): `decideGitPush` over the org's
 * default, the member's standing allow, run grants and scheduled task grants; approvals of kind
 * `git` (the display-only `approval_requested.git`, `once` as a run grant, `always` as the
 * member's `git_push:<owner>/<repo>` policy, expiry, skip, the person who may decide) and a trial
 * run's 「这次允许」 kept as a task grant.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let approvals: ApprovalsService;
const store = new ScheduledTaskStore();

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = configFrom(() => base);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 10);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let seed: Awaited<ReturnType<typeof seedConversation>>;
/** A personal connector (the actor's own connection) and an org one, both git sources. */
let personal: string;
let orgOwned: string;
let runId: string;

/** Another conversation of the seed's agent (one active run per conversation). */
async function newConversation(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${id}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
  return id;
}

async function insertRun(
  id: string,
  opts: {
    status?: string;
    budgetRunId?: string | null;
    taskRunId?: string | null;
    conversationId?: string;
  } = {},
) {
  const conversationId = opts.conversationId ?? (await newConversation());
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, budget_run_id, scheduled_task_run_id)
    VALUES (${id}, ${conversationId}, ${opts.status ?? "waiting"}, 1, ${seed.accountId}, 0,
      ${opts.budgetRunId ?? null}, ${opts.taskRunId ?? null})`.execute(raw);
}

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  seed = await seedConversation(raw);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${seed.orgId}, ${seed.accountId}, 'member')`.execute(raw);
  personal = await seedConnector(raw, seed.orgId, seed.accountId, {
    slug: "github",
    auth: { type: "oauth2", ownership: "personal" },
  });
  orgOwned = await seedConnector(raw, seed.orgId, seed.accountId, {
    slug: "github-bot",
    auth: { type: "bearer", ownership: "org" },
  });
  runId = randomUUID();
  await insertRun(runId, { conversationId: seed.conversationId });
  approvals = approvalsFor(db, eventLog, () => base);
});

const RESULT = { content: "! [remote rejected] feat/x (approval needed)", isError: true };

function ask(over: Partial<GitAskInput> = {}, detail: Partial<GitAskInput["detail"]> = {}) {
  return approvals.requestGit({
    orgId: seed.orgId,
    conversationId: seed.conversationId,
    runId,
    step: 1,
    callId: `c-${randomUUID().slice(0, 8)}`,
    requestedFor: seed.accountId,
    connectorId: personal,
    detail: {
      host: "github.com",
      repo: "acme/app",
      refs: ["refs/heads/feat/x"],
      command: "git push origin feat/x",
      result: RESULT,
      ...detail,
    },
    ...over,
  });
}

const push = (over: Partial<Parameters<typeof decideGitPush>[2]> = {}) =>
  decideGitPush(db, config, {
    orgId: seed.orgId,
    accountId: seed.accountId,
    runId,
    connectorId: personal,
    host: "github.com",
    repo: "acme/app",
    ...over,
  });

const setOrgDefault = (connectorId: string, policy: "allow" | "ask" | "deny") =>
  sql`UPDATE capybara.connectors SET git_push_policy = ${policy} WHERE id = ${connectorId}`.execute(
    raw,
  );

const memberPolicies = () =>
  db
    .selectFrom("connector_tool_account_policies")
    .select(["connector_id", "account_id", "tool_name", "policy"])
    .execute();

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
  return null;
};

describe("decideGitPush", { timeout: 60_000 }, () => {
  it("asks by default (the connector's git_push is ask); a fresh connector column says so", async () => {
    expect(await push()).toEqual({ decision: "ask", reason: "ask", repo: "acme/app" });
    // the repository is keyed lower-case without .git
    expect((await push({ repo: "Acme/App.git" })).repo).toBe("acme/app");
    expect(await push({ repo: "acme" })).toEqual({
      decision: "deny",
      reason: "invalid_repo",
      repo: null,
    });
  });

  it("the org's default allows or denies; a deleted or another org's connector is unavailable", async () => {
    await setOrgDefault(personal, "allow");
    expect((await push()).reason).toBe("org_allow");
    await setOrgDefault(personal, "deny");
    expect(await push()).toMatchObject({ decision: "deny", reason: "org_deny" });
    expect(await push({ orgId: randomUUID() })).toMatchObject({ reason: "unavailable" });
    await sql`UPDATE capybara.connectors SET deleted_at = now() WHERE id = ${orgOwned}`.execute(
      raw,
    );
    expect(await push({ connectorId: orgOwned })).toMatchObject({ reason: "unavailable" });
  });

  it("a member's standing allow counts on a personal connector only; a member deny holds", async () => {
    for (const connectorId of [personal, orgOwned]) {
      await sql`INSERT INTO capybara.connector_tool_account_policies
          (org_id, connector_id, account_id, tool_name, policy)
        VALUES (${seed.orgId}, ${connectorId}, ${seed.accountId}, 'git_push:github.com/acme/app', 'allow')`.execute(
        raw,
      );
    }
    expect(await push()).toMatchObject({ decision: "allow", reason: "member_allow" });
    // another repository, another host, and the org connector (it pushes as the org): asked
    expect((await push({ repo: "acme/other" })).decision).toBe("ask");
    expect((await push({ host: "ghe.example.com" })).decision).toBe("ask");
    expect((await push({ connectorId: orgOwned })).decision).toBe("ask");
    // the org's deny is a floor no member setting lifts
    await setOrgDefault(personal, "deny");
    expect(await push()).toMatchObject({ decision: "deny", reason: "org_deny" });
    await setOrgDefault(personal, "allow");
    await sql`UPDATE capybara.connector_tool_account_policies SET policy = 'deny'
      WHERE connector_id = ${personal}`.execute(raw);
    expect(await push()).toMatchObject({ decision: "deny", reason: "member_deny" });
  });
});

describe("git asks", { timeout: 60_000 }, () => {
  it("are approvals of kind git with the display-only approval_requested.git; one per call", async () => {
    const a = await ask();
    expect(a).toMatchObject({
      kind: "git",
      toolKey: "Bash",
      connectorId: personal,
      requestedFor: seed.accountId,
      scopes: ["once", "always"],
      detail: null,
      git: { host: "github.com", repo: "acme/app", refs: ["refs/heads/feat/x"], result: RESULT },
    });
    // routes and cards never get the kept command result
    expect(publicRecord(a).git).toEqual({
      host: "github.com",
      repo: "acme/app",
      refs: ["refs/heads/feat/x"],
      command: "git push origin feat/x",
    });
    expect((await ask({ callId: a.callId })).id).toBe(a.id);
    const events = (await eventsOf(db, seed.conversationId)).filter(
      (e): e is Extract<ConversationEvent, { type: "approval_requested" }> =>
        e.type === "approval_requested",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      approvalId: a.id,
      toolKey: "Bash",
      git: { host: "github.com", repo: "acme/app", refs: ["refs/heads/feat/x"] },
    });
    expect(events[0]?.payload).not.toHaveProperty("network");
    // an org connector's push acts as the org: only this time
    expect((await ask({ connectorId: orgOwned })).scopes).toEqual(["once"]);
    // only a normalized repository and a member of the org
    await expect(ask({}, { repo: "Acme/App" })).rejects.toThrow("normalized");
    await expect(ask({ requestedFor: randomUUID() })).rejects.toThrow("member of the org");
  });

  it("「这次允许」 is a run grant for that repository in the live run tree only", async () => {
    const a = await ask();
    const d = await approvals.decide(seed.orgId, a.id, seed.accountId, {
      decision: "approve",
      scope: "once",
    });
    expect(d).toMatchObject({ status: "approved", scope: "once", git: { outcome: "once" } });
    expect(await push()).toMatchObject({ decision: "allow", reason: "run_grant" });
    expect((await push({ repo: "acme/other" })).decision).toBe("ask");
    expect((await push({ host: "gitlab.com" })).decision).toBe("ask");
    // the grant is the actor's and the connector's: never another person's or source's
    expect((await push({ connectorId: orgOwned })).decision).toBe("ask");
    const other = randomUUID();
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${other}, 'X')`.execute(raw);
    expect((await push({ accountId: other })).decision).toBe("ask");
    // a sub-agent's run of the tree sees it; no member policy was written
    const child = randomUUID();
    await insertRun(child, { budgetRunId: runId });
    expect((await push({ runId: child })).reason).toBe("run_grant");
    expect(await memberPolicies()).toEqual([]);
    expect((await gitRunState(db, runId)).granted).toEqual(new Set(["github.com/acme/app"]));
    // the grant ends with its run
    await sql`UPDATE capybara.runs SET status = 'completed' WHERE id = ${runId}`.execute(raw);
    expect((await push()).decision).toBe("ask");
  });

  it("「这个仓库一直允许」 writes the member's git_push:<repo> allow; later runs push without asking", async () => {
    const a = await ask();
    await approvals.decide(seed.orgId, a.id, seed.accountId, {
      decision: "approve",
      scope: "always",
    });
    expect(await memberPolicies()).toEqual([
      {
        connector_id: personal,
        account_id: seed.accountId,
        tool_name: "git_push:github.com/acme/app",
        policy: "allow",
      },
    ]);
    const later = randomUUID();
    await insertRun(later, { status: "running" });
    expect(await push({ runId: later })).toMatchObject({
      decision: "allow",
      reason: "member_allow",
    });
    // an org connector's ask offers no always
    const b = await ask({ connectorId: orgOwned });
    expect(
      await errorCode(
        approvals.decide(seed.orgId, b.id, seed.accountId, {
          decision: "approve",
          scope: "always",
        }),
      ),
    ).toBe("approval.scope_not_allowed");
  });

  it("a denial refuses the repository for the run; deny stays deny whatever was granted", async () => {
    const a = await ask();
    const d = await approvals.decide(seed.orgId, a.id, seed.accountId, {
      decision: "deny",
      reason: "not now",
    });
    expect(d).toMatchObject({ status: "denied", denyReason: "not now" });
    expect((await gitRunState(db, runId)).refused).toEqual(new Set(["github.com/acme/app"]));
    expect((await push()).decision).toBe("ask");
    // a run grant never lifts the org's deny
    const b = await ask({}, { repo: "acme/two" });
    await approvals.decide(seed.orgId, b.id, seed.accountId, { decision: "approve" });
    expect((await push({ repo: "acme/two" })).reason).toBe("run_grant");
    await setOrgDefault(personal, "deny");
    expect(await push({ repo: "acme/two" })).toMatchObject({
      decision: "deny",
      reason: "org_deny",
    });
  });

  it("only the asked person decides, in a session; expiry and a reply settle it", async () => {
    const other = randomUUID();
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${other}, 'X')`.execute(raw);
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${seed.orgId}, ${other}, 'admin')`.execute(raw);
    const a = await ask();
    expect(
      await errorCode(approvals.decide(seed.orgId, a.id, other, { decision: "approve" })),
    ).toBe("approval.not_found");
    expect(
      await errorCode(
        approvals.decide(seed.orgId, a.id, seed.accountId, { decision: "approve" }, "tok-1"),
      ),
    ).toBe("auth.session_required");
    expect(
      await errorCode(
        approvals.decide(seed.orgId, a.id, seed.accountId, {
          decision: "approve",
          hosts: ["github.com"],
        }),
      ),
    ).toBe("validation_failed");

    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second'
      WHERE id = ${a.id}`.execute(raw);
    expect((await approvals.expire(a.id)).outcome).toBe("expired");
    expect((await gitRunState(db, runId)).refused.has("github.com/acme/app")).toBe(true);

    // the run's starter writes a message: the pending git ask is skipped like a network ask
    const b = await ask({}, { repo: "acme/two" });
    const skipped = await approvals.txHost.run(() =>
      approvals.skipNetworkIn(seed.conversationId, seed.accountId),
    );
    expect(skipped.records.map((r: ApprovalRecord) => [r.id, r.status])).toEqual([
      [b.id, "skipped"],
    ]);
  });
});

describe("unattended runs", { timeout: 60_000 }, () => {
  let taskId: string;
  let taskRunId: string;

  const taskRow = (): ScheduledTaskInsert => ({
    id: taskId,
    orgId: seed.orgId,
    accountId: seed.accountId,
    agentId: seed.agentId,
    name: "Release",
    prompt: "Push.",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
    mode: "conversation",
    conversationId: seed.conversationId,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
  });

  async function taskRun(trial: boolean): Promise<string> {
    taskId = randomUUID();
    taskRunId = randomUUID();
    await store.insertTask(db, taskRow());
    await store.insertRun(db, {
      id: taskRunId,
      taskId,
      orgId: seed.orgId,
      scheduledFor: new Date(),
      trial,
      status: "running",
    });
    const id = randomUUID();
    await insertRun(id, { status: "running", taskRunId });
    return id;
  }

  const u = (over: Partial<UnattendedRun> = {}): UnattendedRun => ({
    taskId,
    taskRunId,
    trial: false,
    unattendedAsk: "fail",
    forbiddenTools: [],
    ...over,
  });

  const addGrant = (toolKey: string) =>
    store.addGrant(db, taskId, { toolKey, specHash: "git", connectorId: null });

  it("fail mode without a grant refuses with the missing grant; wait mode asks", async () => {
    const run = await taskRun(false);
    // read from the run when the caller has no context
    expect(await push({ runId: run })).toEqual({
      decision: "deny",
      reason: "unattended",
      repo: "acme/app",
      missingGrant: { taskRunId, key: "git:push:acme/app" },
    });
    expect(await push({ runId: run, unattended: u({ unattendedAsk: "wait" }) })).toMatchObject({
      decision: "ask",
    });
    // a standing allow or the org's allow needs no task grant
    await setOrgDefault(personal, "allow");
    expect((await push({ runId: run })).reason).toBe("org_allow");
  });

  it("git:push allows every repository, git:push:<repo> that one; never over a deny or a ban", async () => {
    const run = await taskRun(false);
    await addGrant("git:push:acme/app");
    expect(await push({ runId: run, unattended: u() })).toMatchObject({
      decision: "allow",
      reason: "task_grant",
    });
    expect((await push({ runId: run, repo: "acme/other", unattended: u() })).reason).toBe(
      "unattended",
    );
    await addGrant("git:push");
    expect((await push({ runId: run, repo: "acme/other", unattended: u() })).reason).toBe(
      "task_grant",
    );
    expect(
      await push({ runId: run, unattended: u({ forbiddenTools: ["git:push"] }) }),
    ).toMatchObject({ decision: "deny", reason: "forbidden" });
    await setOrgDefault(personal, "deny");
    expect(await push({ runId: run, unattended: u() })).toMatchObject({
      decision: "deny",
      reason: "org_deny",
    });
  });

  it("a forbidden git:push denies before every allow in an unattended run, never in an attended one", async () => {
    const run = await taskRun(false);
    // entries compare normalized: `git:push:Acme/App` forbids acme/app
    for (const forbiddenTools of [
      ["git:push"],
      ["git:push:Acme/App.git"],
      ["Git:Push"],
      ["GIT:PUSH:Acme/App"],
    ]) {
      const ban = u({ forbiddenTools });
      // the org's allow
      await setOrgDefault(personal, "allow");
      expect(await push({ runId: run, unattended: ban })).toMatchObject({
        decision: "deny",
        reason: "forbidden",
      });
      await setOrgDefault(personal, "ask");
      // a member's standing allow
      await sql`INSERT INTO capybara.connector_tool_account_policies
          (org_id, connector_id, account_id, tool_name, policy)
        VALUES (${seed.orgId}, ${personal}, ${seed.accountId}, 'git_push:github.com/acme/app', 'allow')
        ON CONFLICT DO NOTHING`.execute(raw);
      expect(await push({ runId: run, unattended: ban })).toMatchObject({ reason: "forbidden" });
      await sql`DELETE FROM capybara.connector_tool_account_policies`.execute(raw);
      // a task grant
      await addGrant("git:push:acme/app");
      expect(await push({ runId: run, unattended: ban })).toMatchObject({ reason: "forbidden" });
    }
    // another repository is not forbidden by a per-repository entry
    expect(
      (
        await push({
          runId: run,
          repo: "acme/other",
          unattended: u({ forbiddenTools: ["git:push:acme/app"] }),
        })
      ).reason,
    ).toBe("unattended");
    // an attended run (null context) ignores the scheduled-run ban
    await setOrgDefault(personal, "allow");
    expect((await push({ unattended: null })).reason).toBe("org_allow");
  });

  it("a forbidden git:push denies over a run grant of the unattended run", async () => {
    const run = await taskRun(false);
    const a = await ask({ runId: run });
    await approvals.decide(seed.orgId, a.id, seed.accountId, { decision: "approve" });
    expect((await push({ runId: run, unattended: u() })).reason).toBe("run_grant");
    expect(
      await push({ runId: run, unattended: u({ forbiddenTools: ["git:push"] }) }),
    ).toMatchObject({ decision: "deny", reason: "forbidden" });
  });

  it("a trial run asks; its 「这次允许」 becomes the task's git:push:<repo> grant", async () => {
    const run = await taskRun(true);
    expect((await push({ runId: run })).decision).toBe("ask");
    const a = await ask({ runId: run });
    await approvals.decide(seed.orgId, a.id, seed.accountId, { decision: "approve" });
    const grants = await store.listGrants(db, taskId);
    expect(grants.map((g) => [g.toolKey, g.specHash, g.connectorId])).toEqual([
      ["git:push:acme/app", "git", null],
    ]);
  });
});
