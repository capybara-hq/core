import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createLogger } from "../../src/log.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { INVITATION_LINK_NOTE, memberChangeRefusal } from "../../src/platform/ops/orgs.ops.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { deleteExpiredSealedReveals } from "../../src/platform/sealed-reveals.js";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createConv,
  eventsOf,
  PW,
  postMessage,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Member management through the `Platform` tool (platform web parity spec §7.2, maintainer decision
 * Q2, Task 12): an org admin's agent invites, revokes, changes roles and removes members, never
 * touching the actor's own membership, an owner, or a role above the actor's. The invitation token
 * never reaches the model: it is sealed for the approver and revealed once on the web.
 *
 * In the org environment `root` is the owner, `boss` an admin and `mem` a member.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let agentId: string;
const lines: string[] = [];

beforeAll(async () => {
  env = await startOrgEnv({
    logger: createLogger("debug", { write: (line) => lines.push(line) }),
  });
  ops = env.k.app.get(PlatformOperations);
  const res = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Boss's own",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});
afterAll(async () => {
  await env?.stop();
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const ctxOf = (accountId: string, over: Partial<OperationContext> = {}): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  errorRole: "orgAdmin",
  ...over,
});

/** Parses like the tool does, then runs; a service refusal becomes the tool's error. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};

const precheck = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

const roleIn = async (accountId: string) =>
  (
    await env.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", env.orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst()
  )?.role;

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const call = (operation: string, params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;

/** The tool call whose invitation link is read (plan ruling R6: read by call). */
interface CallRef {
  conversationId: string;
  runId: string;
  callId: string;
}

const linkUrl = (c: CallRef) =>
  `/api/v1/orgs/${env.orgId}/conversations/${c.conversationId}/runs/${c.runId}/calls/${c.callId}/invitation-link`;

const reveal = (who: OrgEnv["root"], c: CallRef) => who({ method: "POST", url: linkUrl(c) });

const refOf = (asked: Ev<"approval_requested">): CallRef => ({
  conversationId: asked.conversationId,
  runId: asked.runId ?? "",
  callId: asked.payload.callId,
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe("registration", () => {
  it("registers the member operations as org writes that are never remembered", () => {
    for (const id of [
      "orgs.invite",
      "orgs.revoke-invitation",
      "orgs.set-member-role",
      "orgs.remove-member",
    ]) {
      expect(op(id).confirm, id).toBe("org");
      expect(op(id).rememberable, id).toBe(false);
    }
    expect(op("orgs.invitations").confirm).toBe("read");
  });
});

describe("orgs.invite through an admin's private agent", () => {
  let approvalId: string;
  let ref: CallRef;
  let token: string;
  let invitationId: string;

  it("returns the invitation without its token; the approver reveals the link once", async () => {
    const convId = await createConv(env.boss, env.orgId, agentId);
    await postMessage(env.boss, env.orgId, convId, call("orgs.invite", { role: "member" }));
    const asked = await waitFor(
      async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    expect(asked.payload.toolKey).toBe("Platform:orgs.invite");
    approvalId = asked.payload.approvalId;
    ref = refOf(asked);
    // nothing to show before the call ran
    expect((await reveal(env.boss, ref)).statusCode).toBe(404);
    const ok = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(env.db, convId, 1, 30_000);

    const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
    expect(result).toMatchObject({ toolKey: "Platform", isError: false });
    const out = JSON.parse(result?.content ?? "{}") as {
      invitation: { id: string; role: string };
      link: string;
    };
    expect(out.invitation.role).toBe("member");
    expect(out.link).toBe(INVITATION_LINK_NOTE);
    expect(result?.content).not.toContain("cap_inv_");
    invitationId = out.invitation.id;

    // the owner, for whom the call was not made, gets nothing
    const other = await reveal(env.root, ref);
    expect(other.statusCode).toBe(404);
    expect(errCode(other)).toBe("invitation.link_unavailable");

    const shown = await reveal(env.boss, ref);
    expect(shown.statusCode, shown.body).toBe(200);
    const { url } = shown.json() as { url: string };
    expect(url).toMatch(/^https:\/\/capybara\.example\.com\/invite\/cap_inv_/);
    token = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    // the link works: its public preview names the role
    const preview = await env.mem({ method: "GET", url: `/api/v1/invitations/${token}` });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ role: "member" });

    // read once
    const again = await reveal(env.boss, ref);
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("invitation.link_unavailable");

    // the token appears nowhere else: events, approvals, audit, sealed rows, log lines
    const evs = JSON.stringify(await eventsOf(env.db, convId));
    const approvals = JSON.stringify(await env.db.selectFrom("approvals").selectAll().execute());
    const audit = await env.db.selectFrom("audit_events").selectAll().execute();
    for (const blob of [evs, approvals, JSON.stringify(audit), lines.join("\n")]) {
      expect(blob).not.toContain(token);
    }
    expect(await env.db.selectFrom("platform_sealed_reveals").selectAll().execute()).toEqual([]);
    const created = audit.find(
      (a) => a.action === "org.invitation.created" && a.target === invitationId,
    );
    expect(created?.detail).toMatchObject({ via: "agent", operation: "orgs.invite" });
    const read = audit.find((a) => a.action === "org.invitation.link_shown");
    expect(read).toMatchObject({ actor_account_id: env.bossId, target: invitationId });
  });

  it("asks even under an allow override and a remembered grant (only the person confirms)", async () => {
    const spec = await env.db
      .selectFrom("approvals")
      .select("spec_hash")
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    const res = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Allowed",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff("Platform"),
        },
        visibility: "private",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const allowed = (res.json() as { agent: { id: string } }).agent.id;
    // an `allow` on the tool and the operation's key (the route refuses to save one on a builtin,
    // so it goes into the stored version) and a remembered grant of the operation
    await sql`UPDATE capybara.agent_versions
      SET definition = jsonb_set(definition, '{toolPolicies}',
        ${JSON.stringify({ Platform: "allow", "Platform:orgs.invite": "allow" })}::jsonb)
      WHERE agent_id = ${allowed}`.execute(env.db);
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${env.orgId}, ${env.bossId}, ${allowed}, 'Platform:orgs.invite', ${spec.spec_hash})`.execute(
      env.db,
    );
    const convId = await createConv(env.boss, env.orgId, allowed);
    await postMessage(env.boss, env.orgId, convId, call("orgs.invite", { role: "guest" }));
    const asked = await waitFor(
      async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    const row = await env.db
      .selectFrom("approvals")
      .select(["tool_key", "requested_for", "scopes"])
      .where("id", "=", asked.payload.approvalId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      tool_key: "Platform:orgs.invite",
      requested_for: env.bossId,
      scopes: ["once"],
    });
  });

  it("a personal access token cannot reveal a link (auth.session_required)", async () => {
    const pat = await env.k.app.get(ApiTokenService).createPersonal(env.bossId, { name: "cli" });
    const res = await env.k.http.inject({
      method: "POST",
      url: linkUrl(ref),
      headers: { authorization: `Bearer ${pat.token}`, "x-capybara-csrf": "1" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
  });

  it("orgs.invitations lists it without a token; orgs.revoke-invitation revokes it", async () => {
    const listed = (await run("orgs.invitations", {}, ctxOf(env.bossId))) as {
      items: { id: string; status: string }[];
    };
    expect(listed.items.find((i) => i.id === invitationId)).toMatchObject({ status: "pending" });
    expect(JSON.stringify(listed)).not.toMatch(/token|cap_inv_/);
    await run("orgs.revoke-invitation", { invitationId }, ctxOf(env.bossId));
    const preview = await env.mem({ method: "GET", url: `/api/v1/invitations/${token}` });
    expect(preview.statusCode).toBe(404);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "org.invitation.revoked")
      .where("target", "=", invitationId)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ via: "agent", operation: "orgs.revoke-invitation" });
  });

  it("a link whose invitation was revoked before it was read is never shown", async () => {
    const convId = await createConv(env.boss, env.orgId, agentId);
    await postMessage(env.boss, env.orgId, convId, call("orgs.invite", { role: "member" }));
    const asked = await waitFor(
      async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    const ok = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/approvals/${asked.payload.approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(env.db, convId, 1, 30_000);
    const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
    const id = (JSON.parse(result?.content ?? "{}") as { invitation: { id: string } }).invitation
      .id;
    await run("orgs.revoke-invitation", { invitationId: id }, ctxOf(env.bossId));
    const res = await reveal(env.boss, refOf(asked));
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("invitation.link_unavailable");
    await env.db.deleteFrom("platform_sealed_reveals").where("id", "=", id).execute();
  });

  it("an invite seals one row for its call; the hourly job drops it once expired", async () => {
    const ctx = ctxOf(env.bossId, {
      conversationId: await createConv(env.boss, env.orgId, agentId),
      callId: "call-revoked",
    });
    const out = (await run("orgs.invite", { role: "guest" }, ctx)) as {
      invitation: { id: string };
    };
    expect(await env.db.selectFrom("platform_sealed_reveals").select("id").execute()).toEqual([
      { id: out.invitation.id },
    ]);
    await env.db
      .updateTable("platform_sealed_reveals")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await deleteExpiredSealedReveals(env.db)).toBe(1);
  });
});

describe("refusals before the card", () => {
  it("an owner role cannot be invited (the input refuses it)", () => {
    expect(op("orgs.invite").input.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("orgs.invite refuses a role above the actor's", async () => {
    expect(await precheck("orgs.invite", { role: "admin" }, ctxOf(env.bossId))).toEqual({
      ok: true,
    });
    expect(await precheck("orgs.invite", { role: "admin" }, ctxOf(env.memId))).toMatchObject({
      ok: false,
      code: "member.role_above_actor",
    });
  });

  it("an admin cannot change their own role", async () => {
    expect(
      await precheck(
        "orgs.set-member-role",
        { accountId: env.bossId, role: "member" },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "member.self" });
    await expect(
      run("orgs.set-member-role", { accountId: env.bossId, role: "member" }, ctxOf(env.bossId)),
    ).rejects.toMatchObject({ message: expect.stringContaining("own membership") });
    expect(await roleIn(env.bossId)).toBe("admin");
  });

  it("an admin cannot touch the owner nor make anyone an owner", async () => {
    expect(
      await precheck(
        "orgs.set-member-role",
        { accountId: env.rootId, role: "member" },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "member.owner_untouchable" });
    expect(
      await precheck(
        "orgs.set-member-role",
        { accountId: env.memId, role: "owner" },
        ctxOf(env.bossId),
      ),
    ).toMatchObject({ ok: false, code: "member.owner_untouchable" });
    expect(
      await precheck("orgs.remove-member", { accountId: env.rootId }, ctxOf(env.bossId)),
    ).toMatchObject({ ok: false, code: "member.owner_untouchable" });
    expect(
      await precheck("orgs.remove-member", { accountId: env.bossId }, ctxOf(env.bossId)),
    ).toMatchObject({ ok: false, code: "member.self" });
    await expect(
      run("orgs.remove-member", { accountId: env.rootId }, ctxOf(env.bossId)),
    ).rejects.toThrow(/never touches an owner/);
    expect(await roleIn(env.rootId)).toBe("owner");
  });

  it("refuses under the org row lock a target that became an owner after the precheck", async () => {
    const other = (
      await accountsFor(env.db).createLocal({ login: "racer", password: PW, displayName: "Racer" })
    ).id;
    await env.db
      .insertInto("memberships")
      .values({ org_id: env.orgId, account_id: other, role: "member" })
      .execute();
    const input = { accountId: other, role: "guest" };
    expect(await precheck("orgs.set-member-role", input, ctxOf(env.rootId))).toEqual({ ok: true });
    // promoted between the card and the run
    await env.db
      .updateTable("memberships")
      .set({ role: "owner" })
      .where("org_id", "=", env.orgId)
      .where("account_id", "=", other)
      .execute();
    // the actor is an owner, so the service alone would allow it; the tool's guard refuses
    await expect(run("orgs.set-member-role", input, ctxOf(env.rootId))).rejects.toThrow(
      /never touches an owner/,
    );
    await expect(
      run("orgs.remove-member", { accountId: other }, ctxOf(env.rootId)),
    ).rejects.toThrow(/never touches an owner/);
    expect(await roleIn(other)).toBe("owner");
  });

  it("never raises above the actor's role (the guard itself)", () => {
    expect(
      memberChangeRefusal({ id: "a", role: "member" }, { id: "b", role: "guest" }, "admin"),
    ).toMatchObject({ code: "member.role_above_actor" });
    expect(
      memberChangeRefusal({ id: "a", role: "admin" }, { id: "b", role: "guest" }, "admin"),
    ).toBeNull();
  });
});

describe("role change and removal of an ordinary member", () => {
  it("an admin changes a member's role, then removes them; both audited as via the agent", async () => {
    expect(
      await precheck(
        "orgs.set-member-role",
        { accountId: env.memId, role: "guest" },
        ctxOf(env.bossId),
      ),
    ).toEqual({ ok: true });
    await run("orgs.set-member-role", { accountId: env.memId, role: "guest" }, ctxOf(env.bossId));
    expect(await roleIn(env.memId)).toBe("guest");
    await run("orgs.remove-member", { accountId: env.memId }, ctxOf(env.bossId));
    expect(await roleIn(env.memId)).toBeUndefined();
    const audit = await env.db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("target", "=", env.memId)
      .where("action", "in", ["org.member.role_changed", "org.member.removed"])
      .execute();
    expect(audit.map((a) => a.action).sort()).toEqual([
      "org.member.removed",
      "org.member.role_changed",
    ]);
    for (const a of audit) expect(a.detail).toMatchObject({ via: "agent" });
  });
});
