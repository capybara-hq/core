import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { InitialPasswords } from "../../src/identity/initial-passwords.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createConv, PW, type Req, session } from "../helpers/runs.js";

/**
 * Results shown once are read by tool call, not by approval (profiles govern every approval, plan
 * ruling R6): `POST …/conversations/:conversationId/runs/:runId/calls/:callId/initial-password` and
 * `…/invitation-link`. Only the sealed row's recipient, who can still see the conversation, reads
 * it, once, in a web session. Every refusal is the same unavailable code, saying nothing about
 * which check failed.
 *
 * In the org environment `root` is a super admin and the owner, `boss` an admin and `mem` a
 * member; `root2` is a second super admin, an admin of the org.
 */

let env: OrgEnv;
let root2: Req;
let agentId: string;
let n = 0;

beforeAll(async () => {
  env = await startOrgEnv();
  const root2Id = (
    await accountsFor(env.db).createLocal({
      login: "root2",
      password: PW,
      displayName: "Root Two",
      superAdmin: true,
    })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: root2Id, role: "admin" })
    .execute();
  root2 = await session(env.k, "root2");
  const res = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Shared",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});
afterAll(async () => {
  await env?.stop();
});

interface CallRef {
  conversationId: string;
  runId: string;
  callId: string;
}

const urlOf = (c: CallRef, what: "initial-password" | "invitation-link") =>
  `/api/v1/orgs/${env.orgId}/conversations/${c.conversationId}/runs/${c.runId}/calls/${c.callId}/${what}`;

const readPassword = (who: Req, c: CallRef) =>
  who({ method: "POST", url: urlOf(c, "initial-password") });
const readLink = (who: Req, c: CallRef) =>
  who({ method: "POST", url: urlOf(c, "invitation-link") });

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

/** A fresh call in a new conversation of `who` (the conversation's owner). */
async function callOf(who: Req): Promise<CallRef> {
  return {
    conversationId: await createConv(who, env.orgId, agentId),
    runId: randomUUID(),
    callId: `call_${++n}`,
  };
}

/** Seals an initial password for `call`, read by `recipientAccountId`; returns the account id. */
async function sealPassword(call: CallRef, recipientAccountId: string): Promise<string> {
  const account = await env.k.app
    .get(InitialPasswords)
    .createAccount({ login: `user${++n}`, displayName: `User ${n}` }, recipientAccountId, {
      ...call,
      recipientAccountId,
    });
  return account.id;
}

/** Runs `orgs.invite` as `actorAccountId` in `call` (it seals the link for the actor). */
async function sealLink(call: CallRef, actorAccountId: string): Promise<string> {
  const ops = env.k.app.get(PlatformOperations);
  const op = ops.get("orgs.invite");
  if (op === null) throw new Error("no orgs.invite");
  const ctx: OperationContext = {
    orgId: env.orgId,
    actorAccountId,
    agentId,
    conversationId: call.conversationId,
    runId: call.runId,
    callId: call.callId,
    signal: new AbortController().signal,
    errorRole: "orgAdmin",
  };
  const out = (await op.run(op.input.parse({ role: "member" }), ctx)) as {
    invitation: { id: string };
  };
  return out.invitation.id;
}

describe("initial password by call", () => {
  it("the recipient reads it once; the audit names the call, never the password", async () => {
    const call = await callOf(env.root);
    const accountId = await sealPassword(call, env.rootId);
    const shown = await readPassword(env.root, call);
    expect(shown.statusCode, shown.body).toBe(200);
    const body = shown.json() as { accountId: string; login: string; password: string };
    expect(body.accountId).toBe(accountId);
    expect(body.password).toMatch(/^[A-Za-z0-9]{20}$/);

    const again = await readPassword(env.root, call);
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("account.initial_password_unavailable");

    const audit = await env.db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "account.initial_password_shown")
      .where("target", "=", accountId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_account_id).toBe(env.rootId);
    expect(audit[0]?.detail).toEqual(call);
    expect(
      JSON.stringify(await env.db.selectFrom("audit_events").selectAll().execute()),
    ).not.toContain(body.password);
  });

  it("another super admin of the org, another conversation, an expired row: all unavailable", async () => {
    const call = await callOf(env.root);
    await sealPassword(call, env.rootId);

    const other = await readPassword(root2, call);
    expect(other.statusCode).toBe(404);
    expect(errCode(other)).toBe("account.initial_password_unavailable");

    // the same run and call ids under another conversation of the recipient
    const elsewhere = { ...call, conversationId: await createConv(env.root, env.orgId, agentId) };
    const wrong = await readPassword(env.root, elsewhere);
    expect(wrong.statusCode).toBe(404);
    expect(errCode(wrong)).toBe("account.initial_password_unavailable");

    await sql`UPDATE capybara.account_initial_passwords SET expires_at = now() - interval '1 minute'
      WHERE run_id = ${call.runId}`.execute(env.db);
    const expired = await readPassword(env.root, call);
    expect(expired.statusCode).toBe(404);
    expect(errCode(expired)).toBe("account.initial_password_unavailable");
  });

  it("the recipient no longer seeing the conversation, or not being the recipient: unavailable", async () => {
    // sealed for root in root2's conversation: root2 owns the conversation but is not the
    // recipient; root is the recipient but cannot see the conversation
    const call = await callOf(root2);
    await sealPassword(call, env.rootId);
    for (const who of [root2, env.root]) {
      const res = await readPassword(who, call);
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("account.initial_password_unavailable");
    }

    // the recipient's own conversation, deleted before the read
    const mine = await callOf(env.root);
    await sealPassword(mine, env.rootId);
    await sql`UPDATE capybara.conversations SET deleted_at = now()
      WHERE id = ${mine.conversationId}`.execute(env.db);
    const gone = await readPassword(env.root, mine);
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("account.initial_password_unavailable");
  });

  it("a personal access token is refused (auth.session_required)", async () => {
    const call = await callOf(env.root);
    await sealPassword(call, env.rootId);
    const pat = await env.k.app.get(ApiTokenService).createPersonal(env.rootId, { name: "cli" });
    const res = await env.k.http.inject({
      method: "POST",
      url: urlOf(call, "initial-password"),
      headers: { authorization: `Bearer ${pat.token}`, "x-capybara-csrf": "1" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
    // still readable by the recipient's session
    expect((await readPassword(env.root, call)).statusCode).toBe(200);
  });
});

describe("invitation link by call", () => {
  it("the recipient reads it once; the audit names the call, never the token", async () => {
    const call = await callOf(env.boss);
    const invitationId = await sealLink(call, env.bossId);
    const shown = await readLink(env.boss, call);
    expect(shown.statusCode, shown.body).toBe(200);
    const { url } = shown.json() as { url: string };
    const token = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    expect(token).toMatch(/^cap_inv_/);

    const again = await readLink(env.boss, call);
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("invitation.link_unavailable");

    const audit = await env.db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.invitation.link_shown")
      .where("target", "=", invitationId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_account_id).toBe(env.bossId);
    expect(audit[0]?.detail).toEqual(call);
    expect(
      JSON.stringify(await env.db.selectFrom("audit_events").selectAll().execute()),
    ).not.toContain(token);
  });

  it("the owner of the org, another conversation, an expired row: all unavailable", async () => {
    const call = await callOf(env.boss);
    await sealLink(call, env.bossId);

    const owner = await readLink(env.root, call);
    expect(owner.statusCode).toBe(404);
    expect(errCode(owner)).toBe("invitation.link_unavailable");

    const elsewhere = { ...call, conversationId: await createConv(env.boss, env.orgId, agentId) };
    const wrong = await readLink(env.boss, elsewhere);
    expect(wrong.statusCode).toBe(404);
    expect(errCode(wrong)).toBe("invitation.link_unavailable");

    await sql`UPDATE capybara.platform_sealed_reveals SET expires_at = now() - interval '1 minute'
      WHERE run_id = ${call.runId}`.execute(env.db);
    const expired = await readLink(env.boss, call);
    expect(expired.statusCode).toBe(404);
    expect(errCode(expired)).toBe("invitation.link_unavailable");
  });

  it("not the recipient, or the recipient without the conversation: unavailable", async () => {
    // sealed for boss in root's conversation (the row's recipient is not the conversation owner)
    const call = await callOf(env.root);
    await sealLink(call, env.bossId);
    for (const who of [env.root, env.boss]) {
      const res = await readLink(who, call);
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("invitation.link_unavailable");
    }
  });

  it("a personal access token is refused (auth.session_required)", async () => {
    const call = await callOf(env.boss);
    await sealLink(call, env.bossId);
    const pat = await env.k.app.get(ApiTokenService).createPersonal(env.bossId, { name: "cli2" });
    const res = await env.k.http.inject({
      method: "POST",
      url: urlOf(call, "invitation-link"),
      headers: { authorization: `Bearer ${pat.token}`, "x-capybara-csrf": "1" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("auth.session_required");
    expect((await readLink(env.boss, call)).statusCode).toBe(200);
  });
});
