import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 * org-credential connector that declares git hosts.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

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
