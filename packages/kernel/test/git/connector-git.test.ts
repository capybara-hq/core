import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { gitPushPolicyName } from "../../src/tools/connector-account-policies.js";
import { decideGitPush } from "../../src/tools/git-push-policy.js";
import {
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  startOrgEnv,
} from "../catalog/org-env.js";

/**
 * The kernel side of a connector's git source (sandbox git credentials spec §6.1, §6.2): the
 * create body's `git` (validated by the SDK schema, never echoing a value), a template's `git`
 * copied into `connectors.git_hosts` at install, and `useForGit` settable only on an
 * org-credential connector that declares git hosts; the org's default git push policy (the
 * route and the Platform operation) and the member's standing push decisions on their Permissions sheet.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("connectors").execute();
});

const GIT = { hosts: [{ host: "github.com", username: "x-access-token" }] };

const createBody = (over: Record<string, unknown> = {}) => ({
  name: "GitHub bot",
  slug: `gh_${Math.random().toString(36).slice(2, 8)}`,
  connector: "fake",
  endpoint: { url: env.mcp.url },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: MCP_TOKEN },
  ...over,
});

const create = (body: Record<string, unknown>) =>
  env.boss({ method: "POST", url: `/api/v1/orgs/${env.orgId}/connectors`, payload: body });

const patch = (connectorId: string, body: Record<string, unknown>) =>
  env.boss({
    method: "PATCH",
    url: `/api/v1/orgs/${env.orgId}/connectors/${connectorId}`,
    payload: body,
  });

const row = (id: string) =>
  env.db
    .selectFrom("connectors")
    .select(["git_hosts", "use_for_git"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe("create body git", () => {
  it("stores the declared hosts and shows them on the connector", async () => {
    const r = await create(createBody({ git: GIT }));
    expect(r.statusCode, r.body).toBe(201);
    const c = r.json().connector as { id: string; git: unknown; useForGit: boolean };
    expect(c.git).toEqual(GIT);
    expect(c.useForGit).toBe(false);
    expect(await row(c.id)).toEqual({ git_hosts: GIT.hosts, use_for_git: false });

    const plain = await create(createBody());
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().connector.git).toBeNull();
    expect((await row(plain.json().connector.id)).git_hosts).toBeNull();
  });

  it("refuses bad hosts and credential-like values without echoing them", async () => {
    const bad = [
      { hosts: [{ host: "user:ghp_secretsecret@github.com", username: "x-access-token" }] },
      { hosts: [{ host: "github.com/acme", username: "x-access-token" }] },
      { hosts: [{ host: "*.github.com", username: "x-access-token" }] },
      { hosts: [{ host: "github.com", username: "ghp_secret:value" }] },
      { hosts: [] },
      { hosts: [GIT.hosts[0], GIT.hosts[0]] },
      { hosts: [{ host: "github.com", username: "x-access-token", token: "ghp_x" }] },
    ];
    for (const git of bad) {
      const r = await create(createBody({ git }));
      expect(r.statusCode, JSON.stringify(git)).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
      expect(r.body).not.toContain("ghp_secret");
    }
    expect(await env.db.selectFrom("connectors").select("id").execute()).toEqual([]);
  });
});

describe("useForGit", () => {
  it("is settable only on an org-credential connector that declares git hosts, and audited", async () => {
    const withGit = (await create(createBody({ git: GIT }))).json().connector.id as string;
    const on = await patch(withGit, { useForGit: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().connector.useForGit).toBe(true);
    expect((await row(withGit)).use_for_git).toBe(true);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.updated")
      .where("target", "=", withGit)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ useForGit: { from: false, to: true } });
    const off = await patch(withGit, { useForGit: false });
    expect(off.json().connector.useForGit).toBe(false);

    // no git hosts
    const noGit = (await create(createBody())).json().connector.id as string;
    const r1 = await patch(noGit, { useForGit: true });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.details[0].path).toBe("useForGit");

    // a personal connector: members' own connections are always sources
    const personal = await create(
      createBody({
        auth: { type: "bearer", ownership: "personal" },
        git: GIT,
      }),
    );
    expect(personal.statusCode, personal.body).toBe(201);
    const r2 = await patch(personal.json().connector.id, { useForGit: true });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.details[0].path).toBe("useForGit");
    expect((await row(personal.json().connector.id)).use_for_git).toBe(false);

    // members cannot change it
    const mem = await env.mem({
      method: "PATCH",
      url: `/api/v1/orgs/${env.orgId}/connectors/${withGit}`,
      payload: { useForGit: true },
    });
    expect(mem.statusCode).toBe(403);
  });
});

describe("template install", () => {
  it("copies the template's git into git_hosts; a template without git leaves it null", async () => {
    const item = await seedPlugin(env, {
      name: "gitty",
      skills: [],
      templates: { gh: { git: GIT } },
    });
    const r = await install(env.boss, env, item, {
      connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } } },
    });
    expect(r.statusCode, r.body).toBe(201);
    const made = await env.db
      .selectFrom("connectors")
      .select(["id", "git_hosts", "use_for_git"])
      .where("catalog_item_id", "=", item)
      .execute();
    expect(made).toHaveLength(1);
    expect(made[0]?.git_hosts).toEqual(GIT.hosts);
    expect(made[0]?.use_for_git).toBe(false);

    const plain = await seedPlugin(env, { name: "plain", skills: [] });
    const r2 = await install(env.boss, env, plain, {
      connectors: {
        gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN }, slug: "plain_gh" },
      },
    });
    expect(r2.statusCode, r2.body).toBe(201);
    const [p] = await env.db
      .selectFrom("connectors")
      .select("git_hosts")
      .where("catalog_item_id", "=", plain)
      .execute();
    expect(p?.git_hosts).toBeNull();
  });
});

describe("git push policy (the org default and the member's standing decisions)", () => {
  const push = (connectorId: string, policy: string, req = env.boss) =>
    req({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/connectors/${connectorId}/git-push-policy`,
      payload: { policy },
    });
  const decide = (connectorId: string, accountId: string) =>
    decideGitPush(
      env.db,
      { get: () => ({}) as never },
      {
        orgId: env.orgId,
        accountId,
        runId: randomUUID(),
        connectorId,
        host: "github.com",
        repo: "acme/app",
        unattended: null,
      },
    );

  it("an org admin sets the default; decideGitPush reads it; audited; members and no-git refused", async () => {
    const id = (await create(createBody({ git: GIT }))).json().connector.id as string;
    expect((await decide(id, env.bossId)).decision).toBe("ask");
    const r = await push(id, "allow");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().connector.gitPushPolicy).toBe("allow");
    expect(await decide(id, env.bossId)).toMatchObject({ decision: "allow", reason: "org_allow" });
    const r2 = await push(id, "deny");
    expect(r2.statusCode, r2.body).toBe(200);
    expect(await decide(id, env.bossId)).toMatchObject({ decision: "deny", reason: "org_deny" });
    const audits = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.git_push_policy_changed")
      .where("target", "=", id)
      .orderBy("at")
      .execute();
    expect(audits.map((a) => a.detail)).toEqual([
      { from: "ask", to: "allow" },
      { from: "allow", to: "deny" },
    ]);
    // every reader sees it on the connector
    const got = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/connectors/${id}`,
    });
    expect(got.json().connector.gitPushPolicy).toBe("deny");
    // members cannot change it; a connector without git hosts has none
    expect((await push(id, "allow", env.mem)).statusCode).toBe(403);
    const noGit = (await create(createBody())).json().connector.id as string;
    const r3 = await push(noGit, "allow");
    expect(r3.statusCode).toBe(400);
    expect(r3.json().error.details[0].path).toBe("policy");
    expect((await push(id, "always")).statusCode).toBe(400);
  });

  it("an API token may only tighten it: loosening -> 400 connector.git_push_widen_not_allowed", async () => {
    const id = (await create(createBody({ git: GIT }))).json().connector.id as string;
    const { token } = await env.k.app
      .get(ApiTokenService)
      .createPersonal(env.bossId, { name: "ci" });
    const viaPat = (policy: string) =>
      env.k.http.inject({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/connectors/${id}/git-push-policy`,
        headers: { authorization: `Bearer ${token}` },
        payload: { policy },
      });
    const wide = await viaPat("allow");
    expect(wide.statusCode).toBe(400);
    expect(wide.json().error.code).toBe("connector.git_push_widen_not_allowed");
    const narrow = await viaPat("deny");
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect(narrow.json().connector.gitPushPolicy).toBe("deny");
    expect((await viaPat("ask")).statusCode).toBe(400);
    // a person in a session loosens it
    expect((await push(id, "allow")).statusCode).toBe(200);
  });

  it("the Platform operation only tightens; loosening is refused before the card", async () => {
    const ops = env.k.app.get(PlatformOperations);
    const op = ops.get("connectors.set-git-push-policy");
    if (op === null) throw new Error("no operation");
    const id = (await create(createBody({ git: GIT }))).json().connector.id as string;
    const ctx: OperationContext = {
      orgId: env.orgId,
      actorAccountId: env.bossId,
      agentId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      signal: new AbortController().signal,
    };
    const input = (policy: string) => op.input.parse({ connectorId: id, policy });
    expect(await op.precheck?.(input("allow"), ctx)).toMatchObject({
      ok: false,
      code: "connector.git_push_widen_not_allowed",
    });
    await expect(op.run(input("allow"), ctx)).rejects.toMatchObject({
      code: "connector.git_push_widen_not_allowed",
    });
    expect(await op.precheck?.(input("deny"), ctx)).toEqual({ ok: true });
    // a connector without git hosts fails before the card too
    const noGit = (await create(createBody())).json().connector.id as string;
    expect(
      await op.precheck?.(op.input.parse({ connectorId: noGit, policy: "deny" }), ctx),
    ).toMatchObject({ ok: false, code: "validation_failed" });
    expect(await op.summary?.(input("deny"), ctx)).toMatchObject({
      en: expect.stringContaining("to deny"),
    });
    expect(await op.summary?.(input("ask"), ctx)).toMatchObject({
      zh: expect.stringContaining("「需审批」"),
    });
    const out = (await op.run(input("deny"), ctx)) as { connector: { gitPushPolicy: string } };
    expect(out.connector.gitPushPolicy).toBe("deny");
    const [row] = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.git_push_policy_changed")
      .where("target", "=", id)
      .execute();
    expect(row?.detail).toMatchObject({
      from: "ask",
      to: "deny",
      via: "agent",
      operation: "connectors.set-git-push-policy",
    });
  });

  it("a member's 权限 sheet lists their standing push decisions; they may clear, never set one", async () => {
    const id = (
      await create(createBody({ auth: { type: "bearer", ownership: "personal" }, git: GIT }))
    ).json().connector.id as string;
    const name = gitPushPolicyName("github.com", "acme/app");
    await env.db
      .insertInto("connector_tool_account_policies")
      .values([
        {
          org_id: env.orgId,
          connector_id: id,
          account_id: env.memId,
          tool_name: name,
          policy: "allow",
        },
        // another member's decision never shows
        {
          org_id: env.orgId,
          connector_id: id,
          account_id: env.bossId,
          tool_name: name,
          policy: "allow",
        },
      ])
      .execute();
    expect(await decide(id, env.memId)).toMatchObject({
      decision: "allow",
      reason: "member_allow",
    });
    const url = `/api/v1/orgs/${env.orgId}/connectors/${id}/tool-policies/me`;
    const sheet = await env.mem({ method: "GET", url });
    expect(sheet.statusCode, sheet.body).toBe(200);
    expect(sheet.json().gitPush).toEqual({
      orgDefault: "ask",
      grants: [{ name, host: "github.com", repo: "acme/app", policy: "allow" }],
    });
    // the tools list stays the connector's tools
    expect(
      (sheet.json().tools as { name: string }[]).some((t) => t.name.startsWith("git_push:")),
    ).toBe(false);
    const set = await env.mem({ method: "PUT", url, payload: { tools: { [name]: "deny" } } });
    expect(set.statusCode).toBe(400);
    expect(set.json().error.details[0].path).toBe(`tools.${name}`);
    const cleared = await env.mem({ method: "PUT", url, payload: { tools: { [name]: null } } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().gitPush).toEqual({ orgDefault: "ask", grants: [] });
    expect(await decide(id, env.memId)).toMatchObject({ decision: "ask" });
    // the boss's own decision is untouched
    expect(await decide(id, env.bossId)).toMatchObject({ decision: "allow" });

    // a personal connector without git hosts has no push part
    const plain = (
      await create(createBody({ auth: { type: "bearer", ownership: "personal" } }))
    ).json().connector.id as string;
    const none = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/connectors/${plain}/tool-policies/me`,
    });
    expect(none.json().gitPush).toBeNull();
  });
});
