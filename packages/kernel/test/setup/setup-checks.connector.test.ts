import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionHost } from "../../src/extensions/host.js";
import { type KernelCheckArgs, SetupCheckRegistry } from "../../src/setup/setup-check-registry.js";
import {
  importPlugin,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  startOrgEnv,
} from "../catalog/org-env.js";
import { mcpTemplate, templateFiles } from "../catalog/packages.js";
import { accountsFor } from "../helpers/identity.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { enableExtensions, PW, type Req, session, waitFor } from "../helpers/runs.js";

// Setup checks for connectors made from a template (spec 2026-11-09-setup-guides-v2-design.md
// §10.2, §10.7; the T7 review's T10 requirements 2 and 6): a plugin check gets the connector's ids
// and only the caller's account, never a credential; member checks (plugin and kernel) are cached
// per account, so member B never sees member A's answer.

const PLUGIN = "gh-checks";
const TEMPLATE = "github-mcp";

const DOC = [
  "# Set up the {{templateName}} connector",
  "",
  "::: audience admin",
  "::check target The target the check gets",
  "::check capybara:test-account Who asked",
  ":::",
  "",
  "::: audience member",
  "::check target The target the check gets",
  "::check capybara:test-account Who asked",
  ":::",
  "",
].join("\n");

/** The extension: one connector check that answers with the target it was given (JSON). */
const ENTRY = [
  'import { defineExtension } from "@capybara-hq/plugin-sdk";',
  "export default defineExtension({",
  `  name: ${JSON.stringify(PLUGIN)}, version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [],`,
  '  permissions: { setupChecks: ["target"] },',
  "  setup(ctx) {",
  '    ctx.setup.check("target", {',
  '      place: "connector-template",',
  "      run: async ({ target }) => ({",
  '        status: "ok",',
  "        reason: { en: JSON.stringify({ keys: Object.keys(target), target }) },",
  "      }),",
  "    });",
  "  },",
  "});",
].join("\n");

let env: OrgEnv;
let itemId: string;
let connectorId: string;
let mem2: Req;
let mem2Id: string;
let adm2: Req;
let adm2Id: string;
const kernelCalls: KernelCheckArgs[] = [];

type State = { status: string; reason?: { en: string }; checkedAt?: string };

beforeAll(async () => {
  env = await startOrgEnv();
  await resetOrgCatalog(env);
  env.k.app
    .get(SetupCheckRegistry)
    .registerKernel("capybara:test-account", "connector-template", async (a) => {
      kernelCalls.push(a);
      return { status: "ok", reason: { en: `asked by ${a.accountId}` } };
    });
  itemId = await importPlugin(
    env,
    await pluginTgz({
      manifest: {
        name: PLUGIN,
        setupGuides: [{ id: "gh", place: "connector-template", template: TEMPLATE }],
      },
      files: { ...templateFiles(TEMPLATE, mcpTemplate()), "guides/gh.md": DOC },
      extension: { manifest: { permissions: { setupChecks: ["target"] } }, entry: ENTRY },
    }),
  );
  await waitFor(
    async () => env.k.app.get(ExtensionHost).current(PLUGIN) !== undefined,
    15_000,
    PLUGIN,
  );
  await enableExtensions(env.db, env.orgId, PLUGIN);
  const r = await install(env.boss, env, itemId, {
    connectors: {
      [TEMPLATE]: {
        name: "Team GitHub",
        endpoint: { url: env.mcp.url },
        credential: { token: MCP_TOKEN },
      },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  connectorId = (
    await env.db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", env.orgId)
      .where("catalog_item_id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow()
  ).id;
  mem2Id = (
    await accountsFor(env.db).createLocal({ login: "mem2", password: PW, displayName: "M2" })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: mem2Id, role: "member" })
    .execute();
  mem2 = await session(env.k, "mem2");
  adm2Id = (
    await accountsFor(env.db).createLocal({ login: "adm2", password: PW, displayName: "A2" })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: adm2Id, role: "admin" })
    .execute();
  adm2 = await session(env.k, "adm2");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

const url = (path: string) => `/api/v1/orgs/${env.orgId}/catalog/${itemId}/guides/gh${path}`;

async function run(req: Req, check: string, audience: "admin" | "member"): Promise<State> {
  const r = await req({
    method: "POST",
    url: url(`/checks/${check}/run`),
    payload: { connectorId, audience },
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { result: State }).result;
}

async function states(req: Req, audience: "admin" | "member"): Promise<Record<string, State>> {
  const r = await req({
    method: "GET",
    url: url(`/checks?connectorId=${connectorId}&audience=${audience}`),
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { results: Record<string, State> }).results;
}

describe("setup checks for connectors", { timeout: 60_000 }, () => {
  it("a plugin check gets the connector's ids field by field, the account only for members", async () => {
    const admin = JSON.parse((await run(env.boss, "target", "admin")).reason?.en ?? "{}");
    expect(admin.keys).toEqual(["kind", "connectorId", "templateId", "clientId", "accountId"]);
    // a bearer template has no manual OAuth client: no client id, and never a credential
    expect(admin.target).toEqual({
      kind: "connector",
      connectorId,
      templateId: TEMPLATE,
      clientId: null,
      accountId: null,
    });
    const member = JSON.parse((await run(env.mem, "target", "member")).reason?.en ?? "{}");
    expect(member.target.accountId).toBe(env.memId);
  });

  it("a kernel check gets ids and the plugin, and the connector's stored credentials to redact", async () => {
    kernelCalls.length = 0;
    await run(env.boss, "capybara:test-account", "admin");
    expect(kernelCalls).toHaveLength(1);
    const a = kernelCalls[0] as KernelCheckArgs;
    expect(a.target).toEqual({
      kind: "connector",
      connectorId,
      templateId: TEMPLATE,
      plugin: PLUGIN,
    });
    expect(a.accountId).toBe(env.bossId);
    expect(a.secrets).toContain(MCP_TOKEN);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("member checks are cached per account: B never sees A's answer", async () => {
    kernelCalls.length = 0;
    const a = await run(env.mem, "capybara:test-account", "member");
    expect(a.reason?.en).toBe(`asked by ${env.memId}`);
    expect((await states(env.mem, "member"))["capybara:test-account"]?.reason?.en).toBe(
      `asked by ${env.memId}`,
    );
    // B's row is not run yet: A's cached answer is not B's
    expect((await states(mem2, "member"))["capybara:test-account"]?.status).toBe("not_run");
    expect((await states(mem2, "member")).target?.status).not.toBe("ok");
    const b = await run(mem2, "capybara:test-account", "member");
    expect(b.reason?.en).toBe(`asked by ${mem2Id}`);
    expect(kernelCalls.map((c) => c.accountId)).toEqual([env.memId, mem2Id]);
    // A still reads A's own answer
    expect((await states(env.mem, "member"))["capybara:test-account"]?.reason?.en).toBe(
      `asked by ${env.memId}`,
    );
    // the plugin check's member rows are per account too
    const t2 = JSON.parse((await run(mem2, "target", "member")).reason?.en ?? "{}");
    expect(t2.target.accountId).toBe(mem2Id);
    const t1 = (await states(env.mem, "member")).target;
    expect(JSON.parse(t1?.reason?.en ?? "{}").target.accountId).toBe(env.memId);
  });

  it("kernel checks get the caller's account, so admin rows are per account too", async () => {
    kernelCalls.length = 0;
    const a = await run(env.boss, "capybara:test-account", "admin");
    expect(a.reason?.en).toBe(`asked by ${env.bossId}`);
    // another admin never reads the first admin's answer of an account-aware kernel check
    expect((await states(adm2, "admin"))["capybara:test-account"]?.status).toBe("not_run");
    const b = await run(adm2, "capybara:test-account", "admin");
    expect(b.reason?.en).toBe(`asked by ${adm2Id}`);
    expect(kernelCalls.at(-1)?.accountId).toBe(adm2Id);
    // a plugin check of the admin audience gets no account and stays shared between admins
    await run(env.boss, "target", "admin");
    expect((await states(adm2, "admin")).target?.status).toBe("ok");
  });

  it("a member cannot run the admin checks", async () => {
    const r = await env.mem({
      method: "POST",
      url: url("/checks/target/run"),
      payload: { connectorId, audience: "admin" },
    });
    expect(r.statusCode).toBe(403);
  });
});
