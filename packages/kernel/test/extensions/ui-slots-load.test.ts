import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionManifest, SDK_VERSION, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { readExtensionPackage } from "../../src/extensions/package.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { blobsFor } from "../helpers/extensions.js";
import { accountsFor } from "../helpers/identity.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * UI slots at load (UI slots spec §3.2, step A): the host resolves each contribution's slot once per
 * load, drops contributions to unknown slots (the extension still loads), logs the drop once and
 * lists it on the admin view; a manifest still on the deprecated `place` (the `todo@0.1.0-rc.2`
 * shape, installed from a packed tgz so the reviewed static manifest is compared) loads with all
 * its UI.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const UI_SLOTS = fixture("ui-slots");
const UI_PREVIEW_DROPPED = fixture("ui-preview-dropped");
const LEGACY_SRC = fixture("ui-legacy-place");
const MAX_BYTES = 4 * 1024 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let pluginsDir: string;
let k: TestKernel;
let host: ExtensionHost;
let admin: Req;
const lines: string[] = [];

type LogLine = { level: string; msg: string; [k: string]: unknown };
const logs = (msg: string): LogLine[] =>
  lines.map((l) => JSON.parse(l) as LogLine).filter((l) => l.msg === msg);

/** The fixture `ui-legacy-place` as a plugin tgz (entry = the same source, types stripped). */
async function legacyPkg(): Promise<Uint8Array> {
  const source = await readFile(LEGACY_SRC, "utf8");
  const mod = (await import(LEGACY_SRC)) as { default: ExtensionManifest };
  return pluginTgz({
    manifest: { name: mod.default.name, version: mod.default.version },
    packageName: "@test/plugin-ui-legacy-place",
    extension: {
      manifest: staticManifestOf(mod.default) as unknown as Record<string, unknown>,
      entry: stripTypeScriptTypes(source, { mode: "strip" }),
    },
  });
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-ui-slots-"));
  // ui-legacy-place is an install record (a packed tgz): its static manifest is checked at load
  const bytes = await legacyPkg();
  const pkg = await readExtensionPackage(bytes, {
    maxBytes: MAX_BYTES,
    hostSdkVersion: SDK_VERSION,
  });
  await blobsFor(db, { maxBytes: MAX_BYTES }).put(pkg, bytes, {
    source: "file",
    ref: "upload",
    actor: null,
    store: "pg",
  });
  await db
    .insertInto("extension_installs")
    .values({
      name: "ui-legacy-place",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: "0.1.0",
      source: "file",
      desired_state: "enabled",
    })
    .execute();
  const base = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      extensionHost: { dir: pluginsDir },
      packages: { maxBytes: MAX_BYTES },
    },
  );
  k = await startKernel(
    { ...base, extensions: [...base.extensions, UI_SLOTS, UI_PREVIEW_DROPPED] },
    { env: {}, logger: createLogger("info", { write: (l) => lines.push(l) }) },
  );
  host = k.app.get(ExtensionHost);
  const accounts = accountsFor(db);
  await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true });
  admin = await session(k, "root");
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** An org with both fixtures on and a conversation whose agent may call their tools. */
async function conversation(): Promise<{ orgId: string; convId: string }> {
  const orgId = await createOrg(admin, `Acme ${Math.random().toString(36).slice(2, 8)}`);
  for (const plugin of ["ui-slots", "ui-legacy-place", "ui-preview-dropped"]) {
    const r = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  const res = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([
          { kind: "plugin", plugin: "ui-slots", name: "ping" },
          { kind: "plugin", plugin: "ui-legacy-place", name: "write" },
        ]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  return { orgId, convId: await createConv(admin, orgId, agentId) };
}

async function toolResult(
  orgId: string,
  convId: string,
  text: string,
  n: number,
): Promise<Extract<ConversationEvent, { type: "tool_result" }>> {
  const r = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload: { text },
  });
  expect(r.statusCode, r.body).toBe(202);
  await waitForTerminal(db, convId, n, 20_000);
  const results = (await eventsOf(db, convId)).filter(
    (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
  );
  return results[results.length - 1] as Extract<ConversationEvent, { type: "tool_result" }>;
}

describe("UI slots at load", () => {
  it("a contribution in an unknown slot is dropped and the extension loads", async () => {
    expect(host.current("ui-slots")).toBeDefined();
    const ids = host
      .uiContributions()
      .filter((c) => c.plugin === "ui-slots")
      .map((c) => [c.contribution.id, c.slot.id]);
    expect(ids).toEqual([
      ["notes", "agent.detail.section"],
      ["org-admin", "org.settings.section"],
      ["platform-home", "platform.page"],
      ["page", "org.page"],
      ["platform-embed", "platform.page"],
      ["page-embed", "org.page"],
      ["notes-embed", "agent.detail.section"],
    ]);
    expect(host.uiDropped("ui-slots")).toEqual([
      { id: "lost", ref: "nowhere.at-all", reason: "unknown-slot" },
      { id: "old-page", ref: "org.page@2", reason: "unsupported-version" },
    ]);
    expect(host.uiDropped("not-loaded")).toEqual([]);
    // the tool of the extension is callable
    const { orgId, convId } = await conversation();
    const r = await toolResult(orgId, convId, "tool:plugin__ui-slots__ping:{}", 1);
    expect(JSON.stringify(r.payload.content)).toContain("pong");
  });

  it("GET /api/v1/admin/extensions/ui-slots lists uiDropped", async () => {
    const r = await admin({ method: "GET", url: "/api/v1/admin/extensions/ui-slots" });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { uiDropped: unknown }).uiDropped).toEqual([
      { id: "lost", ref: "nowhere.at-all", reason: "unknown-slot" },
      { id: "old-page", ref: "org.page@2", reason: "unsupported-version" },
    ]);
    const legacy = await admin({ method: "GET", url: "/api/v1/admin/extensions/ui-legacy-place" });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect((legacy.json() as { uiDropped: unknown }).uiDropped).toEqual([]);
  });

  it("the todo rc.2 manifest shape loads with all its UI", () => {
    const inst = host.current("ui-legacy-place");
    expect(inst?.source).toBe("install");
    expect(
      host
        .uiContributions()
        .filter((c) => c.plugin === "ui-legacy-place")
        .map((c) => [c.contribution.id, c.slot.id, c.after]),
    ).toEqual([
      ["tasks-panel", "conversation.panel", undefined],
      ["tasks-section", "conversation.properties.section", "context"],
      ["tasks-card", "conversation.tool-result.card", undefined],
      ["tasks", "conversation.panel", undefined],
    ]);
    expect(host.uiDropped("ui-legacy-place")).toEqual([]);
    const info = logs("plugin ui uses the deprecated place");
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({
      level: "info",
      plugin: "ui-legacy-place",
      ids: ["tasks-panel", "tasks-section", "tasks-card", "tasks"],
    });
  });

  it("dropped contributions are neither listed nor served; platform.page not through an org", async () => {
    const { orgId } = await conversation();
    const ui = `/api/v1/orgs/${orgId}/ui`;
    const list = await admin({ method: "GET", url: `${ui}/contributions` });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      (list.json() as { items: { plugin: string; id: string }[] }).items
        .filter((i) => i.plugin === "ui-slots")
        .map((i) => i.id),
    ).toEqual(["notes", "org-admin", "page", "page-embed", "notes-embed"]);
    for (const id of ["platform-home", "lost", "old-page"]) {
      const r = await admin({ method: "GET", url: `${ui}/views/ui-slots/${id}` });
      expect(r.statusCode, `${id}: ${r.body}`).toBe(404);
    }
    const token = await admin({
      method: "POST",
      url: `${ui}/embeds/ui-slots/platform-embed/token`,
      payload: {},
    });
    expect(token.statusCode, token.body).toBe(404);
    expect((await admin({ method: "GET", url: `${ui}/views/ui-slots/page` })).statusCode).toBe(200);
  });

  it("a previewer whose embed names a dropped contribution is left out; the extension loads", async () => {
    expect(host.current("ui-preview-dropped")).toBeDefined();
    expect(host.uiDropped("ui-preview-dropped")).toEqual([
      { id: "old-embed", ref: "file.preview@2", reason: "unsupported-version" },
    ]);
    const { orgId } = await conversation();
    const r = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/file-previewers` });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (r.json() as { items: { plugin: string; id: string }[] }).items
        .filter((i) => i.plugin === "ui-preview-dropped")
        .map((i) => i.id),
    ).toEqual(["txt"]);
    const warned = logs("plugin file previewers dropped");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      level: "warn",
      plugin: "ui-preview-dropped",
      version: "0.1.0",
      previewers: [
        {
          previewer: "old",
          embed: "old-embed",
          ref: "file.preview@2",
          reason: "unsupported-version",
        },
      ],
    });
  });

  it("the pipeline keeps a card naming an inline contribution declared with place", async () => {
    const { orgId, convId } = await conversation();
    const r = await toolResult(orgId, convId, "tool:plugin__ui-legacy-place__write:{}", 1);
    expect(r.payload.card).toEqual({
      plugin: "ui-legacy-place",
      view: "tasks-card",
      key: "snap-1",
    });
  });
});
