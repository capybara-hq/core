import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createAgent } from "../helpers/runs.js";
import {
  importPlugin,
  type OrgEnv,
  resetOrgCatalog,
  setPolicy,
  setScope,
  startOrgEnv,
} from "./org-env.js";

// Plugin setup guides (spec 2026-11-08-plugin-setup-guides-design.md): stored with the version on
// import, rendered by the kernel with the place's safe variables, scoped like the catalog icon.

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("channel_connections").execute();
});

const SOCKET = [
  "display_information:",
  '  name: "{{connectionName}}"',
  "settings:",
  "  socket_mode_enabled: true",
  "# {{appSecret}} {{ publicUrl }}",
  "",
].join("\n");
const WEBHOOK = [
  "settings:",
  "  event_subscriptions:",
  '    request_url: "{{webhookUrl}}"',
  "oauth_config:",
  "  redirect_urls:",
  '    - "{{signInCallbackUrl}}"',
  "",
].join("\n");

const GUIDE = {
  id: "app",
  place: "channel-connection",
  title: { en: "Create the app", zh: "创建应用" },
  steps: [
    { en: "Org {{orgName}}, plugin {{pluginName}} {{pluginVersion}}.", zh: "组织 {{orgName}}。" },
    { en: "Mode {{mode}}: set the URL to {{webhookUrl}}.", mode: "webhook" },
  ],
  files: [
    {
      path: "./guides/manifest.socket.yaml.tmpl",
      title: { en: "App manifest", zh: "应用 manifest" },
      language: "yaml",
      mode: "long_connection",
    },
    {
      path: "./guides/manifest.webhook.yaml.tmpl",
      title: { en: "App manifest" },
      language: "yaml",
      mode: "webhook",
    },
  ],
};

/** A plugin `im-guide` whose extension provides channel@1, with {@link GUIDE}. */
const guidePlugin = (over: { guides?: unknown[]; files?: Record<string, string> } = {}) =>
  pluginTgz({
    manifest: {
      name: "im-guide",
      setupGuides: (over.guides ?? [GUIDE]) as never,
    },
    files: over.files ?? {
      "guides/manifest.socket.yaml.tmpl": SOCKET,
      "guides/manifest.webhook.yaml.tmpl": WEBHOOK,
    },
    extension: { manifest: { provides: ["channel@1"] } },
  });

const guideUrl = (itemId: string, guideId = "app", query = "") =>
  `/api/v1/orgs/${env.orgId}/catalog/${itemId}/guides/${guideId}${query}`;

type Rendered = {
  version: string;
  modes: string[];
  mode: string | null;
  steps: { en: string; zh?: string }[];
  files: { title: { en: string }; language: string; fileName: string; content: string }[];
  unresolved: string[];
  hash: string;
};

const render = async (itemId: string, query = "", req = env.boss): Promise<Rendered> => {
  const r = await req({ method: "GET", url: guideUrl(itemId, "app", query) });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { guide: Rendered }).guide;
};

describe("plugin setup guides", { timeout: 60_000 }, () => {
  it("import stores the guide files with the version; the org renders them with its variables", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["manifest", "files"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect((v.manifest as { setupGuides: unknown[] }).setupGuides).toHaveLength(1);
    expect((v.files as { path: string }[]).map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "guides/manifest.socket.yaml.tmpl",
        "guides/manifest.webhook.yaml.tmpl",
      ]),
    );

    // 新建渠道: no connection yet, the name typed so far stands in (escaped for YAML)
    const g = await render(itemId, `?name=${encodeURIComponent('Sales "bot"')}`);
    expect(g.version).toBe("1.0.0");
    expect(g.modes).toEqual(["long_connection", "webhook"]);
    expect(g.mode).toBe("long_connection");
    expect(g.steps).toEqual([{ en: "Org Acme, plugin im-guide 1.0.0.", zh: "组织 Acme。" }]);
    expect(g.files).toHaveLength(1);
    expect(g.files[0]?.fileName).toBe("manifest.socket.yaml");
    expect(g.files[0]?.language).toBe("yaml");
    // the name escaped inside the double quotes; an unknown placeholder stays as written
    expect(g.files[0]?.content).toContain('name: "Sales \\"bot\\""');
    expect(g.files[0]?.content).toContain("# {{appSecret}} https://capybara.example.com");
    expect(g.unresolved).toEqual([]);

    // the webhook mode: its own file and step; without a connection the webhook URL is unresolved
    const w = await render(itemId, "?mode=webhook");
    expect(w.mode).toBe("webhook");
    expect(w.files.map((f) => f.fileName)).toEqual(["manifest.webhook.yaml"]);
    expect(w.files[0]?.content).toContain('request_url: "{{webhookUrl}}"');
    expect(w.files[0]?.content).toContain(
      '- "https://capybara.example.com/api/v1/auth/sso/im-guide/callback"',
    );
    expect(w.steps[1]?.en).toBe("Mode webhook: set the URL to {{webhookUrl}}.");
    expect(w.unresolved).toEqual(["webhookUrl"]);
    expect(w.hash).not.toBe(g.hash);
  });

  it("renders for a connection: its name and mode, never its config or secrets", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    const agentId = await createAgent(env.root, env.orgId);
    const connectionId = randomUUID();
    const SECRET = "xoxb-secret-1f2e3d";
    await env.db
      .insertInto("channel_connections")
      .values({
        id: connectionId,
        org_id: env.orgId,
        plugin: "im-guide",
        name: "Support bot",
        agent_id: agentId,
        config: JSON.stringify({ appId: "A1", appSecret: SECRET }),
        inbound_mode: "webhook",
        created_by: env.rootId,
      })
      .execute();
    const r = await env.boss({
      method: "GET",
      url: guideUrl(itemId, "app", `?connectionId=${connectionId}`),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(SECRET);
    const g = (r.json() as { guide: Rendered }).guide;
    // the connection's mode by default; no webhook base URL configured: still unresolved
    expect(g.mode).toBe("webhook");
    expect(g.unresolved).toEqual(["webhookUrl"]);
    const s = await render(itemId, `?connectionId=${connectionId}&mode=long_connection`);
    expect(s.files[0]?.content).toContain('name: "Support bot"');
    expect(JSON.stringify(s)).not.toContain(SECRET);
    // a connection of another plugin, or unknown: 404
    const other = await env.boss({
      method: "GET",
      url: guideUrl(itemId, "app", `?connectionId=${randomUUID()}`),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("channel.not_found");
  });

  it("scoped like the catalog icon: members, unknown guides and modes, hidden items", async () => {
    const itemId = await importPlugin(env, await guidePlugin());
    // a channel guide is for channels.manage (org admins)
    const mem = await env.mem({ method: "GET", url: guideUrl(itemId) });
    expect(mem.statusCode).toBe(403);
    const unknown = await env.boss({ method: "GET", url: guideUrl(itemId, "nope") });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("catalog.guide_not_found");
    const badMode = await env.boss({
      method: "GET",
      url: guideUrl(itemId, "app", "?mode=polling"),
    });
    expect(badMode.statusCode).toBe(400);
    const badQuery = await env.boss({ method: "GET", url: guideUrl(itemId, "app", "?x=1") });
    expect(badQuery.statusCode).toBe(400);
    // a named item that does not list the org and is not shown to others: not found
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
      url: `/api/v1/orgs/${env.orgId}/catalog/nope/guides/app`,
    });
    expect(notUuid.statusCode).toBe(404);
  });

  it("import refuses a missing or binary guide file and a channel guide without an extension", async () => {
    const prepare = async (bytes: Uint8Array) =>
      env.root({
        method: "POST",
        url: "/api/v1/admin/catalog/import/file",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(bytes),
      });
    const missing = await prepare(
      await guidePlugin({ files: { "guides/manifest.socket.yaml.tmpl": SOCKET } }),
    );
    expect(missing.statusCode).toBe(422);
    expect(missing.body).toContain("guides/manifest.webhook.yaml.tmpl not found in the package");
    const binary = await prepare(
      await guidePlugin({
        files: {
          "guides/manifest.socket.yaml.tmpl": SOCKET,
          "guides/manifest.webhook.yaml.tmpl": "a\u0000b",
        },
      }),
    );
    expect(binary.statusCode).toBe(422);
    expect(binary.body).toContain("NUL");
    const noExtension = await prepare(
      await pluginTgz({
        manifest: {
          name: "guide-only",
          skills: [{ path: "./skills/notes" }],
          setupGuides: [GUIDE] as never,
        },
        files: {
          "skills/notes/SKILL.md": "---\nname: notes\ndescription: Notes\n---\nBody\n",
          "guides/manifest.socket.yaml.tmpl": SOCKET,
          "guides/manifest.webhook.yaml.tmpl": WEBHOOK,
        },
      }),
    );
    expect(noExtension.statusCode).toBe(422);
    expect(noExtension.body).toContain("needs the plugin's extension to provide channel@1");
  });
});
