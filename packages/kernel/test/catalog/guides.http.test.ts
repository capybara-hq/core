import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setupGuideHash } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { PluginGuides } from "../../src/extensions/plugin-guides.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createAgent, createOrg } from "../helpers/runs.js";
import {
  importPlugin,
  type OrgEnv,
  resetOrgCatalog,
  setPolicy,
  setScope,
  startOrgEnv,
} from "./org-env.js";
import { mcpTemplate, templateFiles } from "./packages.js";

// Setup guides v2 (spec 2026-11-09-setup-guides-v2-design.md §6, §7, §9): Markdown documents stored
// with the version on import, rendered per org and target with the place's safe variables, scoped
// like the catalog icon and by the place and audience's org action.

const DOCS = new URL("../fixtures/plugins/guide-demo/guides/", import.meta.url);
const EN = readFileSync(new URL("demo.md", DOCS), "utf8");
const ZH = readFileSync(new URL("demo.zh.md", DOCS), "utf8");
const PUBLIC_URL = "https://capybara.example.com";

let env: OrgEnv;
/** A second org (the super admin owns it). */
let otherOrgId: string;

beforeAll(async () => {
  env = await startOrgEnv();
  otherOrgId = await createOrg(env.root, "Globex");
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("channel_connections").execute();
});

/** The plugin `im-guide` (extension providing channel@1) with the `demo` channel guide. */
const guidePlugin = (o: { zh?: boolean } = {}) =>
  pluginTgz({
    manifest: {
      name: "im-guide",
      setupGuides: [{ id: "demo", place: "channel-connection" }],
    },
    files: {
      "guides/demo.md": EN,
      ...(o.zh !== false && { "guides/demo.zh.md": ZH }),
    },
    extension: { manifest: { provides: ["channel@1"] } },
  });

const CONNECTOR_DOC = [
  "# Set up the {{templateName}} connector",
  "",
  "For {{orgName}}.",
  "",
  "::: audience admin",
  "Register `{{oauthCallbackUrl}}` for {{templateId}}; connector {{connectorName}}.",
  "",
  "::check capybara:oauth-token-endpoint Token endpoint answers",
  ":::",
  "",
  "::: audience member",
  "Connect your account in {{orgName}}.",
  ":::",
  "",
].join("\n");

const CONNECTOR_DOC_ZH = [
  "# 设置 {{templateName}}",
  "",
  "用于 {{orgName}}。",
  "",
  "::: audience admin",
  "为 {{templateId}} 登记 `{{oauthCallbackUrl}}`；连接器 {{connectorName}}。",
  "",
  "::check capybara:oauth-token-endpoint 令牌端点可用",
  ":::",
  "",
  "::: audience member",
  "在 {{orgName}} 里连接你的账号。",
  ":::",
  "",
].join("\n");

/** A templates-only plugin `gh-guide` whose template `github-mcp` has the `gh` guide. */
const connectorPlugin = () =>
  pluginTgz({
    manifest: {
      name: "gh-guide",
      setupGuides: [{ id: "gh", place: "connector-template", template: "github-mcp" }],
    },
    files: {
      ...templateFiles("github-mcp", mcpTemplate(), {
        displayName: { zh: "GitHub 连接器", en: "GitHub MCP" },
      }),
      "guides/gh.md": CONNECTOR_DOC,
      "guides/gh.zh.md": CONNECTOR_DOC_ZH,
    },
  });

const guideUrl = (itemId: string, guideId = "demo", query = "") =>
  `/api/v1/orgs/${env.orgId}/catalog/${itemId}/guides/${guideId}${query}`;

type Block =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string; title: string | null; text: string }
  | { kind: "check"; id: string; label: string };
type Rendered = {
  itemId: string;
  plugin: string;
  version: string;
  id: string;
  place: string;
  locale: "en" | "zh";
  title: string;
  modes: string[];
  mode: string | null;
  audiences: string[];
  audience: string;
  blocks: Block[];
  checks: { id: string; label: string; source: string }[];
  unresolved: { name: string; reason: string }[];
  hash: string;
  target: { kind: string; id: string } | null;
};

/** Prose without the U+2060 word joiners the renderer inserts against GFM autolinks. */
const prose = (g: Rendered) =>
  g.blocks
    .filter((b) => b.kind === "markdown")
    .map((b) => b.text.replaceAll("⁠", ""))
    .join("\n");
const code = (g: Rendered) =>
  g.blocks.filter((b): b is Extract<Block, { kind: "code" }> => b.kind === "code");

/** Inserts a live channel connection row (the guide route reads the row only). */
const insertConnection = async (
  orgId: string,
  plugin: string,
  o: { name?: string; mode?: "webhook" | "long_connection"; config?: object } = {},
) => {
  const id = randomUUID();
  await env.db
    .insertInto("channel_connections")
    .values({
      id,
      org_id: orgId,
      plugin,
      name: o.name ?? "Support bot",
      agent_id: await createAgent(env.root, orgId),
      config: JSON.stringify(o.config ?? { appId: "A1" }),
      inbound_mode: o.mode ?? "webhook",
      created_by: env.rootId,
    })
    .execute();
  return id;
};

const render = async (
  itemId: string,
  query = "",
  req = env.boss,
  guideId = "demo",
): Promise<Rendered> => {
  const r = await req({ method: "GET", url: guideUrl(itemId, guideId, query) });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { guide: Rendered }).guide;
};

/** Stubs the config the renderer reads (neither setting is hot). */
const withConfig = async (
  patch: (c: KernelConfig) => KernelConfig,
  fn: () => Promise<void>,
): Promise<void> => {
  const config = env.k.app.get(KernelConfigService);
  const real = config.get.bind(config);
  const spy = vi.spyOn(config, "get").mockImplementation(() => patch(real()));
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
};

describe("setup guides v2: rendering", () => {
  it("renders the channel guide for an org admin", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["manifest", "files"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect((v.manifest as { setupGuides: unknown[] }).setupGuides).toEqual([
      { id: "demo", place: "channel-connection" },
    ]);
    expect((v.files as { path: string }[]).map((f) => f.path)).toEqual(
      expect.arrayContaining(["guides/demo.md", "guides/demo.zh.md"]),
    );

    const connectionId = await insertConnection(env.orgId, "im-guide", { mode: "webhook" });
    const g = await render(itemId, `?connectionId=${connectionId}`);
    expect(g).toMatchObject({
      itemId,
      plugin: "im-guide",
      version: "1.0.0",
      id: "demo",
      place: "channel-connection",
      locale: "en",
      title: "Create the demo app",
      modes: ["long_connection", "webhook"],
      // the connection's stored mode by default
      mode: "webhook",
      audiences: [],
      audience: "admin",
      target: { kind: "channel-connection", id: connectionId },
    });
    expect(g.hash).toBe(
      setupGuideHash(EN, {
        place: "channel-connection",
        guideId: "demo",
        mode: "webhook",
        audience: "admin",
      }),
    );
    expect(g.blocks.map((b) => b.kind)).toEqual(["markdown", "code", "markdown", "check", "check"]);
    expect(code(g)[0]).toMatchObject({ language: "yaml", title: "App manifest (webhook)" });
    expect(code(g)[0]?.text).toContain('name: "Support bot"');
    expect(code(g)[0]?.text).toContain(`- "${PUBLIC_URL}/api/v1/auth/sso/im-guide/callback"`);
    expect(prose(g)).toContain("Org Acme, plugin im-guide 1.0.0, mode webhook.");
    expect(g.checks).toEqual([
      { id: "bot-token", label: "Bot token works", source: "plugin" },
      { id: "capybara:public-url", label: "Public URL is set", source: "kernel" },
    ]);

    // 新建渠道: no connection, the place's first mode, the name typed so far (escaped for YAML)
    const n = await render(itemId, `?name=${encodeURIComponent('Sales "bot"')}`);
    expect(n.mode).toBe("long_connection");
    expect(n.target).toBeNull();
    expect(code(n)).toHaveLength(1);
    expect(code(n)[0]?.title).toBe("App manifest (long connection)");
    expect(code(n)[0]?.text).toContain('name: "Sales \\"bot\\""');
    expect(code(n)[0]?.text).toContain(`# ${PUBLIC_URL}`);
    expect(n.unresolved).toEqual([]);
    expect(n.hash).not.toBe(g.hash);
    // an explicit mode wins over the connection's
    const s = await render(itemId, `?connectionId=${connectionId}&mode=long_connection`);
    expect(s.mode).toBe("long_connection");
    expect(s.target).toEqual({ kind: "channel-connection", id: connectionId });
  });

  it("renders zh and falls back to en", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const en = await render(itemId, "?mode=webhook");
    const zh = await render(itemId, "?mode=webhook&locale=zh");
    expect(zh.locale).toBe("zh");
    expect(zh.title).toBe("创建演示应用");
    expect(zh.checks.map((c) => c.label)).toEqual(["机器人令牌可用", "已设置公网地址"]);
    expect(code(zh)[0]?.title).toBe("应用 manifest（webhook）");
    // the same code and the same hash in every language
    expect(code(zh).map((c) => c.text)).toEqual(code(en).map((c) => c.text));
    expect(zh.hash).toBe(en.hash);

    await resetOrgCatalog(env);
    const enOnly = await importPlugin(env, await guidePlugin({ zh: false }));
    const fallback = await render(enOnly, "?locale=zh");
    expect(fallback.locale).toBe("en");
    expect(fallback.title).toBe("Create the demo app");
  });

  it("refuses a member (403 forbidden)", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const r = await env.mem({ method: "GET", url: guideUrl(itemId) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
  });

  it("refuses an org that cannot see the item (404 catalog.item_not_found)", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    // another org's item that is not shareable: the share gate
    const owner = (o: { owner_org_id: string | null; shareable: boolean }) =>
      env.db.updateTable("catalog_items").set(o).where("id", "=", itemId).execute();
    await owner({ owner_org_id: otherOrgId, shareable: false });
    const gated = await env.boss({ method: "GET", url: guideUrl(itemId) });
    expect(gated.statusCode).toBe(404);
    expect(gated.json().error.code).toBe("catalog.item_not_found");
    await owner({ owner_org_id: otherOrgId, shareable: true });
    await render(itemId);
    await owner({ owner_org_id: null, shareable: false });
    // a named item that does not list the org and is not shown to others
    await setScope(env, itemId, "named", []);
    await env.db
      .updateTable("catalog_items")
      .set({ shown_to_others: false })
      .where("id", "=", itemId)
      .execute();
    const hidden = await env.boss({ method: "GET", url: guideUrl(itemId) });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("catalog.item_not_found");
    await setScope(env, itemId, "named", [env.orgId]);
    await render(itemId);
    // disabled: org admins still see the item, so its guide too
    await setPolicy(env, itemId, "disabled");
    await render(itemId);
    const notUuid = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/nope/guides/demo`,
    });
    expect(notUuid.statusCode).toBe(404);
    const unknown = await env.boss({ method: "GET", url: guideUrl(randomUUID()) });
    expect(unknown.json().error.code).toBe("catalog.item_not_found");
  });

  it("refuses another org's connection (404 channel.not_found)", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    for (const connectionId of [
      await insertConnection(otherOrgId, "im-guide"),
      await insertConnection(env.orgId, "other-im"),
      randomUUID(),
      "not-a-uuid",
    ]) {
      const r = await env.boss({
        method: "GET",
        url: guideUrl(itemId, "demo", `?connectionId=${connectionId}`),
      });
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error.code).toBe("channel.not_found");
      expect(r.body).not.toContain("Support bot");
    }
  });

  it("rejects an unknown mode or audience (400 validation_failed)", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    for (const query of [
      "?mode=polling",
      "?audience=member",
      "?audience=boss",
      "?locale=fr",
      "?x=1",
      `?connectorId=${randomUUID()}`,
    ]) {
      const r = await env.boss({ method: "GET", url: guideUrl(itemId, "demo", query) });
      expect(r.statusCode, `${query}: ${r.body}`).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
    const unknown = await env.boss({ method: "GET", url: guideUrl(itemId, "nope") });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("catalog.guide_not_found");
  });

  it("unresolved reasons", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    // no connection: the webhook URL needs a saved connection
    const fresh = await render(itemId, "?mode=webhook&name=Bot");
    expect(fresh.unresolved).toEqual([{ name: "webhookUrl", reason: "not_saved" }]);
    expect(prose(fresh)).toContain("{{webhookUrl}}");
    // a connection, but no channels.webhookBaseUrl
    const connectionId = await insertConnection(env.orgId, "im-guide");
    const noBase = await render(itemId, `?connectionId=${connectionId}`);
    expect(noBase.unresolved).toEqual([{ name: "webhookUrl", reason: "webhook_base" }]);
    // nothing typed on 新建渠道: the connection name waits for the form
    const unnamed = await render(itemId, "?name=%20");
    expect(unnamed.unresolved).toEqual([{ name: "connectionName", reason: "no_name" }]);

    await withConfig(
      (c) =>
        ({
          ...c,
          channels: { ...c.channels, webhookBaseUrl: "https://hooks.example.com/" },
        }) as KernelConfig,
      async () => {
        const g = await render(itemId, `?connectionId=${connectionId}`);
        const url = `https://hooks.example.com/channels/webhook/${connectionId}`;
        expect(g.unresolved).toEqual([]);
        expect(code(g)[0]?.text).toContain(`request_url: "${url}"`);
        // a url variable in prose becomes an explicit link
        const md = g.blocks.find(
          (b) => b.kind === "markdown" && b.text.includes("posts events"),
        ) as { text: string };
        expect(md.text).toContain(`<${url}>`);
      },
    );

    // no http.publicUrl: the URLs built from it
    await withConfig(
      (c) => ({ ...c, http: { ...c.http, publicUrl: undefined } }) as KernelConfig,
      async () => {
        const g = await render(itemId, "?mode=webhook&name=Bot");
        expect(g.unresolved).toEqual([
          { name: "webhookUrl", reason: "not_saved" },
          { name: "signInCallbackUrl", reason: "public_url" },
        ]);
        const l = await render(itemId, "?name=Bot");
        expect(l.unresolved).toEqual([{ name: "publicUrl", reason: "public_url" }]);
      },
    );
  });

  it("a v1-shaped stored manifest renders no guide", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    // a version imported before setup guides v2 keeps its v1 entry (title, steps, files)
    const v1 = {
      id: "demo",
      place: "channel-connection",
      title: { en: "Create the app" },
      steps: [{ en: "Open the console." }],
      files: [{ path: "./guides/m.yaml.tmpl", title: { en: "M" }, language: "yaml" }],
    };
    const row = await env.db
      .selectFrom("catalog_item_versions")
      .select("manifest")
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    await env.db
      .updateTable("catalog_item_versions")
      .set({ manifest: JSON.stringify({ ...(row.manifest as object), setupGuides: [v1] }) })
      .where("item_id", "=", itemId)
      .execute();
    const guides = env.k.app.get(PluginGuides);
    // the logger PluginGuides got (KERNEL_LOGGER is transient: one instance per consumer)
    const log = (guides as unknown as { log: { warn: (...a: unknown[]) => void } }).log;
    const warn = vi.spyOn(log, "warn");
    try {
      const r = await env.boss({ method: "GET", url: guideUrl(itemId) });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("catalog.guide_not_found");
      // logged once for the render, naming the plugin and version
      const skipped = warn.mock.calls.filter(([m]) => String(m).startsWith("setup guide entries"));
      expect(skipped).toEqual([
        [
          expect.any(String),
          expect.objectContaining({ plugin: "im-guide", version: "1.0.0", skipped: 1 }),
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
    // the channel pages find no guide either: no ref, no drift for a connection of the plugin
    const connectionId = await insertConnection(env.orgId, "im-guide");
    const org = { orgId: env.orgId, role: "owner" as const };
    expect(await guides.channelGuides(["im-guide"], org)).toEqual(new Map());
    const states = await guides.connectionStates(
      [{ id: connectionId, plugin: "im-guide", guideAck: null }],
      org,
    );
    expect(states.get(connectionId)).toEqual({ setupGuide: null, guideDrift: null });
    expect(await guides.currentAck("im-guide", "channel-connection", { mode: "webhook" })).toBe(
      null,
    );
    const admin = await env.root({
      method: "GET",
      url: `/api/v1/admin/catalog/${itemId}/guides/demo`,
    });
    expect(admin.json().error.code).toBe("catalog.guide_not_found");
  });

  it("contains no secret", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const BOT = "xoxb-secret-1f2e3d4c5b";
    const SIGNING = "signing-secret-9a8b7c6d";
    const connectionId = await insertConnection(env.orgId, "im-guide", {
      config: { appId: "A1", botToken: BOT, signingSecret: SIGNING },
    });
    for (const q of ["", "&mode=long_connection", "&locale=zh"]) {
      const r = await env.boss({
        method: "GET",
        url: guideUrl(itemId, "demo", `?connectionId=${connectionId}${q}`),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(BOT);
      expect(r.body).not.toContain(SIGNING);
      expect(r.body).not.toContain("appId");
    }
  });

  it("renders a connector template guide per audience", async () => {
    const itemId = await importPlugin(env, await connectorPlugin());
    const admin = await render(itemId, "", env.boss, "gh");
    expect(admin).toMatchObject({
      place: "connector-template",
      title: "Set up the GitHub MCP connector",
      modes: [],
      mode: null,
      audiences: ["admin", "member"],
      audience: "admin",
      target: null,
      unresolved: [{ name: "connectorName", reason: "no_connector" }],
    });
    expect(prose(admin)).toContain("For Acme.");
    expect(prose(admin)).toContain(`${PUBLIC_URL}/api/v1/oauth/callback`);
    expect(prose(admin)).toContain("for github-mcp; connector {{connectorName}}.");
    expect(prose(admin)).not.toContain("Connect your account");
    expect(admin.checks.map((c) => c.id)).toEqual(["capybara:oauth-token-endpoint"]);
    // the template's display name in the document's language
    expect((await render(itemId, "?locale=zh", env.boss, "gh")).title).toBe("设置 GitHub 连接器");
    // members read the member text; the admin text needs connectors.manage
    const member = await render(itemId, "?audience=member", env.mem, "gh");
    expect(member.audience).toBe("member");
    expect(prose(member)).toContain("Connect your account in Acme.");
    expect(member.checks).toEqual([]);
    const denied = await env.mem({ method: "GET", url: guideUrl(itemId, "gh") });
    expect(denied.statusCode).toBe(403);
    // an id that is no connector of the org made from the template: 404, never a guide (the
    // connector targets: tools/connector-guides.http.test.ts)
    for (const req of [env.boss, env.mem]) {
      const audience = req === env.mem ? "&audience=member" : "";
      const r = await req({
        method: "GET",
        url: guideUrl(itemId, "gh", `?connectorId=${randomUUID()}${audience}`),
      });
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error.code).toBe("connector.not_found");
    }
    // modes and channel targets are not this place's
    for (const query of ["?mode=webhook", `?connectionId=${randomUUID()}`]) {
      const r = await env.boss({ method: "GET", url: guideUrl(itemId, "gh", query) });
      expect(r.statusCode, query).toBe(400);
    }
  });

  it("admin template guide", async () => {
    const itemId = await importPlugin(env, await connectorPlugin());
    const url = `/api/v1/admin/catalog/${itemId}/guides/gh`;
    const r = await env.root({ method: "GET", url });
    expect(r.statusCode, r.body).toBe(200);
    const g = (r.json() as { guide: Rendered }).guide;
    expect(g).toMatchObject({ place: "connector-template", audience: "admin", target: null });
    expect(g.unresolved).toEqual([
      { name: "orgName", reason: "no_org" },
      { name: "connectorName", reason: "no_connector" },
    ]);
    expect(prose(g)).toContain(`${PUBLIC_URL}/api/v1/oauth/callback`);
    expect(
      ((await env.root({ method: "GET", url: `${url}?locale=zh` })).json() as { guide: Rendered })
        .guide.title,
    ).toBe("设置 GitHub 连接器");
    // the platform view: any live item, also one no org sees
    await setScope(env, itemId, "named", []);
    expect((await env.root({ method: "GET", url })).statusCode).toBe(200);
    // org admins and members: 403
    expect((await env.boss({ method: "GET", url })).statusCode).toBe(403);
    expect((await env.mem({ method: "GET", url })).statusCode).toBe(403);
    // unknown item or guide; a query beyond the locale
    const none = await env.root({
      method: "GET",
      url: `/api/v1/admin/catalog/${randomUUID()}/guides/gh`,
    });
    expect(none.json().error.code).toBe("catalog.item_not_found");
    const noGuide = await env.root({
      method: "GET",
      url: `/api/v1/admin/catalog/${itemId}/guides/x`,
    });
    expect(noGuide.json().error.code).toBe("catalog.guide_not_found");
    expect((await env.root({ method: "GET", url: `${url}?audience=member` })).statusCode).toBe(400);
  });
});
