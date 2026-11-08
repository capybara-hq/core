import { randomUUID } from "node:crypto";
import type { ToolError } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { ExtensionAdminOps } from "../../src/extensions/admin-ops.js";
import {
  PLATFORM_INBOX_MAX_ITEMS,
  type PlatformInboxItem,
  PlatformInboxService,
} from "../../src/inbox/platform-inbox.service.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { type ErrorRole, nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { importDeployedPlugin, type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, PW } from "../helpers/runs.js";

/**
 * Task 9 of Platform phase 2: the inbox and the reads of pending sensitive state (approvals
 * waiting for me, requests pending for the org admins, extensions waiting for permission
 * confirmation) against PG with the real services. Review Focus 5: these reads carry the inbox's
 * summary, never a tool input, a token or a credential value. Deciding stays on the web.
 */

let env: OrgEnv;
let db: KernelSchemaDb;
let ops: PlatformOperations;
let rootId: string;
let adminId: string;
let memberId: string;
let iniId: string;
let orgId: string;
let org2: string;
let agentId: string;
let conversationId: string;
let runId: string;
let mine: string;
let escalated: string;
let requestId: string;
let orgNotice: string;
let platformNotice: string;

/** Secret-like values seeded into approval inputs: none may reach an operation's result. */
const SECRETS = ["sk-live-SECRET123", "hunter2", "tok-XYZ-987", "S3CR3T-CRED", "Bearer abc"];

beforeAll(async () => {
  env = await startOrgEnv();
  db = env.db;
  ops = env.k.app.get(PlatformOperations);
  rootId = env.rootId;
  adminId = env.bossId;
  memberId = env.memId;
  orgId = env.orgId;
  iniId = (await accountsFor(db).createLocal({ login: "ini", password: PW, displayName: "Ini" }))
    .id;
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${iniId}, 'member')`.execute(db);
  org2 = await createOrg(env.root, "Beta Corp");

  agentId = randomUUID();
  conversationId = randomUUID();
  runId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${iniId}, 'org', 1)`.execute(db);
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${agentId}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${iniId})`.execute(db);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${iniId})`.execute(db);
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${runId}, ${conversationId}, 'running', 1, ${iniId}, 0)`.execute(db);

  const approvals = env.k.app.get(ApprovalsService);
  const base = {
    orgId,
    conversationId,
    runId,
    step: 1,
    specHash: "hash-1",
    connectorId: null,
  };
  // the initiator's own approval: its input carries credential-like fields
  mine = (
    await approvals.request({
      ...base,
      callId: "c-mine",
      toolKey: "mcp__docs__create_doc",
      input: {
        title: "Q3 plan",
        apiKey: "sk-live-SECRET123",
        password: "hunter2",
        auth: { token: "tok-XYZ-987", header: "Bearer abc" },
      },
      requestedFor: iniId,
      approverRole: null,
      summary: { zh: "新建文档「Q3 plan」", en: 'Create document "Q3 plan"' },
    })
  ).id;
  // a role escalation: the org admins decide another person's call
  escalated = (
    await approvals.request({
      ...base,
      callId: "c-escalated",
      toolKey: "mcp__vault__write_secret",
      input: { credentials: { secret: "S3CR3T-CRED" } },
      requestedFor: null,
      approverRole: "admin",
    })
  ).id;

  requestId = randomUUID();
  await sql`INSERT INTO capybara.catalog_requests
      (id, org_id, kind, agent_id, pending_keys, stage, requested_by, note, status)
    VALUES (${requestId}, ${orgId}, 'connector_setup', ${agentId}, '["docs"]'::jsonb, 'org',
      ${iniId}, 'Please set up Docs', 'pending')`.execute(db);

  orgNotice = randomUUID();
  await sql`INSERT INTO capybara.org_notices (id, org_id, kind, detail)
    VALUES (${orgNotice}, ${orgId}, 'upload_rejected', ${JSON.stringify({
      itemId: randomUUID(),
      name: "acme-tools",
      displayName: null,
      version: "1.2.0",
      reason: "Needs a review",
    })}::jsonb)`.execute(db);
  platformNotice = randomUUID();
  await sql`INSERT INTO capybara.platform_notices (id, kind, detail)
    VALUES (${platformNotice}, 'ownership_transferred', ${JSON.stringify({
      ref: { kind: "skill", id: randomUUID() },
      name: "weekly-report",
      fromOrg: { id: org2, name: "Beta Corp" },
      reason: "org_deleted",
      usedBy: 2,
    })}::jsonb)`.execute(db);
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const facts = (role: ActorFacts["role"], over: Partial<ActorFacts> = {}): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
  ...over,
});

const ctxOf = (accountId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

const run = (id: string, input: unknown, accountId: string, role: ErrorRole = "member") => {
  const o = op(id);
  return o.run(o.input.parse(input), ctxOf(accountId)).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, role));
  });
};

const precheck = (id: string, input: unknown, accountId: string) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctxOf(accountId));
};

/** Review Focus 5: no seeded secret, no tool input and no token field in a result. */
const expectNoSecrets = (out: unknown) => {
  const text = JSON.stringify(out);
  for (const s of SECRETS) expect(text).not.toContain(s);
  expect(text).not.toMatch(/"(input|apiKey|password|token|credentials|specHash|reviewHash)"/);
};

type Rows = { items: Record<string, unknown>[]; total: number; next: string | null };

describe("registration and who may call", () => {
  it("registers the inbox, approval and pending reads; only notice dismissals write", () => {
    const ids = ops
      .all()
      .map((o) => o.id)
      .filter((id) => /^(inbox|approvals)\./.test(id));
    expect(ids).toEqual([
      "approvals.get",
      "approvals.waiting",
      "inbox.dismiss-notice",
      "inbox.list",
      "inbox.platform-dismiss-notice",
      "inbox.platform-list",
    ]);
    for (const id of [
      "approvals.get",
      "approvals.waiting",
      "inbox.list",
      "inbox.platform-list",
      "requests.pending",
      "extensions.pending-permissions",
    ]) {
      expect(op(id).confirm, id).toBe("read");
    }
    expect(op("inbox.dismiss-notice").confirm).toBe("org");
    expect(op("inbox.platform-dismiss-notice").confirm).toBe("platform");
  });

  it("offers no decision: no operation mirrors a decide, confirm or approve route", () => {
    const decisions = ops
      .all()
      .flatMap((o) => o.mirrors)
      .filter((m) => /\/(decision|decide|approve|confirm)$/.test(m));
    expect(decisions).toEqual([]);
  });

  it("members read their approvals and inbox; pending requests need an org admin", () => {
    for (const id of ["approvals.waiting", "approvals.get", "inbox.list"]) {
      expect(availability(op(id), facts("member")), id).toEqual({ ok: true });
    }
    const a = availability(op("requests.pending"), facts("member"));
    expect(a.ok ? "" : a.reason).toContain("admin");
    expect(availability(op("requests.pending"), facts("admin"))).toEqual({ ok: true });
  });

  it("the platform inbox and pending permissions are the super admin's", () => {
    for (const id of [
      "inbox.platform-list",
      "inbox.platform-dismiss-notice",
      "extensions.pending-permissions",
    ]) {
      const a = availability(op(id), facts("owner"));
      expect(a.ok ? "" : a.reason, id).toContain("super admin");
      expect(availability(op(id), facts("owner", { isSuperAdmin: true })), id).toEqual({
        ok: true,
      });
    }
  });
});

describe("approvals waiting for me (Review Focus 5)", () => {
  it("lists my pending approval with the inbox's summary, never its input", async () => {
    const out = (await run("approvals.waiting", {}, iniId)) as Rows;
    expect(out.items).toEqual([
      expect.objectContaining({
        id: mine,
        name: "mcp__docs__create_doc",
        state: "pending",
        summary: 'Create document "Q3 plan"',
        agent: "Writer",
      }),
    ]);
    expect(out.items[0]?.next).toContain("web");
    expectNoSecrets(out);
  });

  it("an org admin sees the escalated call of another person: tool and agent, no input", async () => {
    const out = (await run("approvals.waiting", {}, adminId)) as Rows;
    expect(out.items.map((r) => r.id)).toEqual([escalated]);
    expect(out.items[0]).toMatchObject({ name: "mcp__vault__write_secret", summary: null });
    expectNoSecrets(out);
    expect(((await run("approvals.waiting", {}, memberId)) as Rows).items).toEqual([]);
  });

  it("reads one approval without input, spec hash or call id", async () => {
    const out = (await run("approvals.get", { id: mine }, iniId)) as {
      approval: Record<string, unknown>;
    };
    expect(out.approval).toMatchObject({
      id: mine,
      toolKey: "mcp__docs__create_doc",
      status: "pending",
      summary: { en: 'Create document "Q3 plan"' },
      agent: { id: agentId, name: "Writer" },
      conversationId,
    });
    expect(out.approval).not.toHaveProperty("callId");
    expectNoSecrets(out);
  });

  it("another person's approval is not found, with the next step", async () => {
    const e = (await run("approvals.get", { id: mine }, memberId).catch(
      (x: unknown) => x,
    )) as ToolError;
    expect(e.message).toContain("approval.not_found");
    expect(e.message).toContain("approvals.waiting");
    expectNoSecrets(e.message);
  });
});

describe("the org inbox", () => {
  it("a member's inbox: their approval as a compact row with the summary, no input", async () => {
    const out = (await run("inbox.list", {}, iniId)) as Rows & { truncated: boolean };
    expect(out.items).toEqual([
      expect.objectContaining({
        id: mine,
        type: "tool_approval",
        name: "mcp__docs__create_doc",
        state: "pending",
      }),
    ]);
    expect(out.items[0]?.summary).toContain('Create document "Q3 plan"');
    expect(out.truncated).toBe(false);
    expectNoSecrets(out);
  });

  it("an org admin's inbox: the escalated approval, the setup request and the org notice", async () => {
    const out = (await run("inbox.list", {}, adminId, "orgAdmin")) as Rows;
    const byType = Object.fromEntries(out.items.map((r) => [r.type, r]));
    expect(Object.keys(byType).sort()).toEqual([
      "catalog_request",
      "tool_approval",
      "upload_rejected",
    ]);
    expect(byType.tool_approval).toMatchObject({ id: escalated });
    expect(byType.catalog_request).toMatchObject({ id: requestId, state: "pending" });
    expect(byType.catalog_request?.summary).toContain("Ini");
    expect(byType.upload_rejected).toMatchObject({ id: orgNotice, name: "acme-tools" });
    expect(byType.upload_rejected?.summary).toContain("Needs a review");
    expectNoSecrets(out);
  });

  it("requests.pending lists the org's pending requests to its admins", async () => {
    const out = (await run("requests.pending", {}, adminId, "orgAdmin")) as Rows;
    expect(out.items).toEqual([
      expect.objectContaining({
        id: requestId,
        name: "Writer",
        state: "pending",
        kind: "connector_setup",
        requestedBy: "Ini",
      }),
    ]);
  });

  it("dismisses an org notice: precheck refuses an unknown id, the summary names it", async () => {
    expect(await precheck("inbox.dismiss-notice", { id: randomUUID() }, adminId)).toMatchObject({
      ok: false,
      code: "inbox.notice_not_found",
    });
    expect(await precheck("inbox.dismiss-notice", { id: orgNotice }, memberId)).toMatchObject({
      ok: false,
      code: "inbox.notice_not_found",
    });
    expect(await precheck("inbox.dismiss-notice", { id: orgNotice }, adminId)).toEqual({
      ok: true,
    });
    const summary = await op("inbox.dismiss-notice").summary?.({ id: orgNotice }, ctxOf(adminId));
    expect(summary?.en).toContain("acme-tools");
    expect(summary?.zh).toContain("acme-tools");
    await run("inbox.dismiss-notice", { id: orgNotice }, adminId, "orgAdmin");
    const out = (await run("inbox.list", {}, adminId, "orgAdmin")) as Rows;
    expect(out.items.map((r) => r.id)).not.toContain(orgNotice);
  });
});

describe("the platform inbox and pending permissions (super admin)", () => {
  it("lists the platform's notices as compact rows with a total", async () => {
    const out = (await run("inbox.platform-list", {}, rootId, "superAdmin")) as Rows & {
      truncated: boolean;
    };
    expect(out.items).toContainEqual(
      expect.objectContaining({
        id: platformNotice,
        type: "ownership_transferred",
        name: "weekly-report",
      }),
    );
    expect(out.total).toBeGreaterThanOrEqual(1);
    expectNoSecrets(out);
  });

  it("a truncated inbox keeps the console's total and says only the newest are listed", async () => {
    const notice = (n: number): PlatformInboxItem => ({
      type: "ownership_transferred",
      id: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      notice: {
        id: randomUUID(),
        kind: "ownership_transferred",
        createdAt: new Date().toISOString(),
        detail: {
          ref: { kind: "skill", id: randomUUID() },
          name: `skill-${n}`,
          fromOrg: { id: randomUUID(), name: "Gone Org" },
          reason: "org_deleted",
          usedBy: 0,
        },
      },
    });
    const items = Array.from({ length: PLATFORM_INBOX_MAX_ITEMS }, (_, n) => notice(n));
    const spy = vi
      .spyOn(env.k.app.get(PlatformInboxService), "list")
      .mockResolvedValue({ items, truncated: true, total: PLATFORM_INBOX_MAX_ITEMS + 30 });
    try {
      const out = (await run("inbox.platform-list", {}, rootId, "superAdmin")) as Rows & {
        truncated: boolean;
        listed: number;
        otherOrgItems: number;
      };
      expect(out).toMatchObject({
        total: PLATFORM_INBOX_MAX_ITEMS + 30,
        listed: PLATFORM_INBOX_MAX_ITEMS,
        truncated: true,
        otherOrgItems: 0,
      });
      expect(out.items).toHaveLength(50);
      expect(out.next).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("dismisses a platform notice after the precheck; an unknown one is refused before the card", async () => {
    expect(
      await precheck("inbox.platform-dismiss-notice", { id: randomUUID() }, rootId),
    ).toMatchObject({ ok: false, code: "inbox.notice_not_found" });
    const summary = await op("inbox.platform-dismiss-notice").summary?.(
      { id: platformNotice },
      ctxOf(rootId),
    );
    expect(summary?.en).toContain("weekly-report");
    await run("inbox.platform-dismiss-notice", { id: platformNotice }, rootId, "superAdmin");
    const out = (await run("inbox.platform-list", {}, rootId, "superAdmin")) as Rows;
    expect(out.items.map((r) => r.id)).not.toContain(platformNotice);
  });

  it("extensions.pending-permissions lists a plugin waiting for a confirmation, no hash", async () => {
    const empty = (await run("extensions.pending-permissions", {}, rootId, "superAdmin")) as Rows;
    expect(empty).toMatchObject({ items: [], total: 0, next: null });
    // imported and deployed, then its extension uninstalled: the item waits for a confirmation
    const { itemId } = await importDeployedPlugin(env, "unconfirmed");
    await env.k.app.get(ExtensionAdminOps).disable("unconfirmed", null);
    await env.k.app.get(ExtensionAdminOps).uninstall("unconfirmed", null);
    const out = (await run("extensions.pending-permissions", {}, rootId, "superAdmin")) as Rows & {
      otherOrgItems: number;
      otherOrgExtensions: number;
    };
    expect(out.items).toEqual([
      expect.objectContaining({ id: itemId, name: "unconfirmed", kind: "plugin" }),
    ]);
    expect(out.items[0]?.next).toContain("admin console");
    expect(out).toMatchObject({ otherOrgItems: 0, otherOrgExtensions: 0 });
    expectNoSecrets(out);
    const inbox = (await run("inbox.platform-list", {}, rootId, "superAdmin")) as Rows;
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ id: itemId, type: "permission_confirmation", name: "unconfirmed" }),
    );
  });
});
