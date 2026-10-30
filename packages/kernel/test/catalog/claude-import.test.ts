import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeGitServer,
  fakeExtensionEntry,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeContentDigest } from "../../src/catalog/claude/manifest.js";
import type { TranslationReport } from "../../src/catalog/claude/report.js";
import { contentDigest } from "../../src/catalog/plugin-package.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { packPackageTgz } from "../../src/packages/tgz.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { loadFixture, loadFixtureAsStrings } from "./claude-fixtures.js";

/** The one import review for Claude Code plugins (spec §8): git marketplaces and direct git imports. */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let k: TestKernel;
let admin: Req;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-claude-import-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api"],
      extensionHost: { dir: pluginsDir },
      marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
      extensions: [OBJECT_STORE],
      extensionConfig: {
        "fake-object-store": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    },
  );
  k = await startKernel(config, { env: {} });
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
}, 240_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await srv?.stop();
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.audit_events",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
});

interface Review {
  name: string;
  version: string;
  pluginVersion?: string;
  format: string;
  contentDigest: string;
  publisher: string;
  license?: string;
  licenseText?: string;
  claudeManifestIgnored?: true;
  licenseTruncated?: true;
  repository?: string;
  extension?: unknown;
  translation?: TranslationReport;
  skills: { name: string; suggestPinned: boolean; path: string }[];
  connectorTemplates: { id: string; plugin: string; endpointChecked: boolean; auth: unknown }[];
  dependencies: { name: string; range: string; resolved: string | null }[];
  reviewHash: string;
}
interface Prepared {
  stagingId: string;
  review: Review;
}

async function addGit(repo: string): Promise<string> {
  const res = await admin({
    method: "POST",
    url: "/api/v1/admin/marketplaces",
    payload: { name: `Claude ${repo}`, url: srv.url(repo), form: "git" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await refresh(id);
  return id;
}
const refresh = async (id: string) => {
  const r = await admin({ method: "POST", url: `/api/v1/admin/marketplaces/${id}/refresh` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const importEntry = (id: string, name: string) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/marketplaces/${id}/entries/${name}/import`,
    payload: {},
  });
const importGit = (payload: Record<string, unknown>) =>
  admin({ method: "POST", url: "/api/v1/admin/catalog/import/git", payload });
const prepared = async (res: Awaited<ReturnType<Req>>): Promise<Prepared> => {
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const confirm = (p: Prepared, extra: Record<string, unknown> = {}) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${p.stagingId}/confirm`,
    payload: { reviewHash: p.review.reviewHash, deployExtension: false, ...extra },
  });
const groups = (r: TranslationReport) =>
  Object.fromEntries(
    ["imported", "converted", "needsInput", "ignored", "warnings"].map((g) => [
      g,
      r.items.filter((i) => i.group === g).map((i) => `${i.code} ${i.name}`),
    ]),
  );
const versionRow = (name: string) =>
  db
    .selectFrom("catalog_item_versions as v")
    .innerJoin("catalog_items as i", "i.id", "v.item_id")
    .select([
      "v.version",
      "v.manifest",
      "v.source_format",
      "v.translation",
      "v.license_text",
      "v.content_digest",
      "v.extension_sha256",
    ])
    .where("i.name", "=", name)
    .orderBy("v.imported_at", "desc")
    .executeTakeFirstOrThrow();

const SUPERPOWERS_GROUPS = {
  imported: [
    "skill_imported brainstorming",
    "skill_imported dispatching-parallel-agents",
    "skill_imported requesting-code-review",
    "skill_imported subagent-driven-development",
    "skill_imported test-driven-development",
    "skill_imported using-superpowers",
    "skill_imported writing-plans",
    "command_imported brainstorm",
    "agent_imported code-reviewer",
  ],
  converted: [],
  needsInput: [],
  ignored: ["hooks_not_run SessionStart", "other_harness .codex-plugin"],
  warnings: ["session_start_pin_hint SessionStart"],
};

describe("importing Claude Code plugins", () => {
  it("importing superpowers from its Claude marketplace: format claude-code, no extension, report groups, license text, 7 skills and the command with suggestPinned false", async () => {
    const files = loadFixtureAsStrings("superpowers");
    await srv.commit("superpowers", files);
    const id = await addGit("superpowers");
    const p = await prepared(await importEntry(id, "superpowers"));
    const r = p.review;
    expect(r).toMatchObject({
      name: "superpowers",
      version: "7.0.1",
      format: "claude-code",
      publisher: "Jesse Vincent",
      license: "MIT",
    });
    expect(r.extension).toBeUndefined();
    expect(r.licenseText).toBe(files.LICENSE);
    // plugin.json repository, display only (spec §8.2)
    expect(r.repository).toBe("https://github.com/obra/superpowers");
    expect(r.translation?.sessionStart).toBe(true);
    expect(r.translation?.manifestPath).toBe(".claude-plugin/plugin.json");
    expect(groups(r.translation as TranslationReport)).toEqual(SUPERPOWERS_GROUPS);
    expect(r.skills.map((s) => [s.name, s.suggestPinned])).toEqual([
      ["brainstorming", false],
      ["dispatching-parallel-agents", false],
      ["requesting-code-review", false],
      ["subagent-driven-development", false],
      ["test-driven-development", false],
      ["using-superpowers", false],
      ["writing-plans", false],
      ["brainstorm", false],
    ]);
    // the digest is over the files as read (Review Focus 5), plus the translator revision, since
    // the plugin has a command (phase D spec §8.3)
    expect(r.contentDigest).toBe(
      claudeContentDigest(loadFixture("superpowers"), undefined, "claude-translation-2"),
    );
    expect(r.contentDigest).not.toBe(contentDigest(loadFixture("superpowers")));
    const reopened = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/imports/${p.stagingId}`,
    });
    expect(reopened.json().review).toEqual(r);

    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(201);
    const v = await versionRow("superpowers");
    expect(v.source_format).toBe("claude-code");
    expect(v.translation).toEqual(r.translation);
    expect(v.license_text).toBe(files.LICENSE);
    expect(v.extension_sha256).toBeNull();
    const detail = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/items/${c.json().item.id}`,
    });
    expect(detail.json().versions[0]).toMatchObject({
      sourceFormat: "claude-code",
      licenseText: files.LICENSE,
      translation: r.translation,
    });
  });

  it("a LICENSE over 64 KiB: the review says licenseTruncated, and so does the stored version in the item detail (batch-3 m6)", async () => {
    const files = { ...loadFixtureAsStrings("superpowers"), LICENSE: "x".repeat(70_000) };
    await srv.commit("long-license", files);
    const p = await prepared(await importGit({ url: srv.url("long-license") }));
    expect(p.review).toMatchObject({ licenseTruncated: true });
    expect(p.review.licenseText).toBeUndefined();
    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(201);
    const detail = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/items/${c.json().item.id}`,
    });
    expect(detail.json().versions[0]).toMatchObject({ licenseText: null, licenseTruncated: true });
    // A version with its license stored says false.
    await truncateTables(db, "capybara.catalog_item_versions, capybara.catalog_items");
    await srv.commit("short-license", loadFixtureAsStrings("superpowers"));
    const q = await prepared(await importGit({ url: srv.url("short-license") }));
    const d = await confirm(q);
    expect(d.statusCode, d.body).toBe(201);
    const shown = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/items/${d.json().item.id}`,
    });
    expect(shown.json().versions[0]).toMatchObject({ licenseTruncated: false });
  });

  it("confirm with pinnedSuggestions [using-superpowers] stores pinned in the version manifest; an unknown name is validation_failed", async () => {
    await srv.commit("superpowers", loadFixtureAsStrings("superpowers"));
    const p = await prepared(await importGit({ url: srv.url("superpowers") }));
    const bad = await confirm(p, { pinnedSuggestions: ["using-superpowers", "nope"] });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("validation_failed");
    expect(bad.json().error.message).toContain('"nope"');
    const c = await confirm(p, { pinnedSuggestions: ["using-superpowers"] });
    expect(c.statusCode, c.body).toBe(201);
    const v = await versionRow("superpowers");
    expect((v.manifest as { skills: unknown[] }).skills).toEqual([
      { path: "./skills/brainstorming" },
      { path: "./skills/dispatching-parallel-agents" },
      { path: "./skills/requesting-code-review" },
      { path: "./skills/subagent-driven-development" },
      { path: "./skills/test-driven-development" },
      { path: "./skills/using-superpowers", pinned: true },
      { path: "./skills/writing-plans" },
      { path: "./.capybara-generated/commands/brainstorm" },
    ]);
    const a = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "catalog.imported")
      .executeTakeFirstOrThrow();
    expect((a.detail as { suggestedPinned: string[] }).suggestedPinned).toEqual([
      "using-superpowers",
    ]);
  });

  it("a changed hooks file gives another reviewHash and report item, and confirm with the old hash is plugin.review_stale (the report alone: plugin-review-hash.test.ts)", async () => {
    const files = loadFixtureAsStrings("superpowers");
    await srv.commit("superpowers", files);
    const first = await prepared(await importGit({ url: srv.url("superpowers") }));
    const hooks = JSON.parse(files["hooks/hooks.json"] as string);
    hooks.hooks.Stop = [{ hooks: [{ type: "command", command: "true" }] }];
    await srv.commit("superpowers", { ...files, "hooks/hooks.json": JSON.stringify(hooks) });
    const second = await prepared(await importGit({ url: srv.url("superpowers") }));
    expect(second.review.reviewHash).not.toBe(first.review.reviewHash);
    expect(
      second.review.translation?.items.some((i) => i.code === "hooks_not_run" && i.name === "Stop"),
    ).toBe(true);
    const stale = await confirm({
      ...second,
      review: { ...second.review, reviewHash: first.review.reviewHash },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("plugin.review_stale");
  });

  it("a direct git import of the mixed fixture: templates for connector-mcp checked statically with connector_not_loaded", async () => {
    await srv.commit("mixed", loadFixtureAsStrings("mixed"));
    const p = await prepared(await importGit({ url: srv.url("mixed") }));
    const r = p.review;
    expect(r.format).toBe("claude-code");
    expect(r.connectorTemplates.map((t) => [t.id, t.plugin, t.endpointChecked])).toEqual([
      ["bearer-api", "connector-mcp", false],
      ["key-api", "connector-mcp", false],
      ["open-api", "connector-mcp", false],
      ["oauth-api", "connector-mcp", false],
      ["inline-api", "connector-mcp", false],
    ]);
    const t = r.translation as TranslationReport;
    expect(
      t.items
        .filter((i) => i.code === "connector_not_loaded")
        .map((i) => [i.group, i.name, i.path, i.detail]),
    ).toEqual([
      [
        "warnings",
        "bearer-api",
        ".capybara-generated/connectors/bearer-api.json",
        { connector: "connector-mcp" },
      ],
      [
        "warnings",
        "inline-api",
        ".capybara-generated/connectors/inline-api.json",
        { connector: "connector-mcp" },
      ],
      [
        "warnings",
        "key-api",
        ".capybara-generated/connectors/key-api.json",
        { connector: "connector-mcp" },
      ],
      [
        "warnings",
        "oauth-api",
        ".capybara-generated/connectors/oauth-api.json",
        { connector: "connector-mcp" },
      ],
      [
        "warnings",
        "open-api",
        ".capybara-generated/connectors/open-api.json",
        { connector: "connector-mcp" },
      ],
    ]);
    expect(groups(t).needsInput).toEqual([
      "dependency_not_imported helper",
      "dependency_not_imported other",
      "dependency_not_imported shared",
      "mcp_header_variable bearer-api",
      "mcp_url_variable host-api",
      "mcp_header_variable key-api",
    ]);
    expect(r.dependencies).toEqual([
      { name: "helper", range: "*", resolved: null },
      { name: "other", range: "^1.0.0", resolved: null },
      { name: "shared", range: "*", resolved: null },
    ]);
    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(201);
    expect((await versionRow("mixed")).source_format).toBe("claude-code");
  });

  it("both manifests: the native one wins and the review says so", async () => {
    await srv.commit("both", {
      ".capybara-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "both",
        version: "1.0.0",
        publisher: "Acme",
        description: "Native manifest",
      }),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "both-claude", version: "9.0.0" }),
      "skills/native/SKILL.md": SKILL_MD("native"),
    });
    const p = await prepared(await importGit({ url: srv.url("both") }));
    expect(p.review).toMatchObject({ name: "both", version: "1.0.0", format: "capybara" });
    expect(p.review.claudeManifestIgnored).toBe(true);
    expect(p.review.translation).toBeUndefined();
    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(201);
    const v = await versionRow("both");
    expect(v.source_format).toBe("capybara");
    expect(v.translation).toBeNull();
  });

  it("re-import (Review Focus 5): unchanged repo -> catalog.version_exists; moved repo -> contentChanged and +git.<sha12>", async () => {
    const files = loadFixtureAsStrings("superpowers");
    await srv.commit("superpowers", files);
    const id = await addGit("superpowers");
    expect((await confirm(await prepared(await importEntry(id, "superpowers")))).statusCode).toBe(
      201,
    );
    // an unchanged repository is already imported
    const again = await importEntry(id, "superpowers");
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe("catalog.version_exists");

    // a new commit with other content at the same version
    const moved = await srv.commit("superpowers", {
      ...files,
      "skills/writing-plans/SKILL.md": `${files["skills/writing-plans/SKILL.md"]}\nOne more line.\n`,
    });
    await refresh(id);
    const listed = await admin({
      method: "GET",
      url: `/api/v1/admin/marketplaces/entries?sourceId=${id}`,
    });
    expect(listed.json().items[0]).toMatchObject({ name: "superpowers", contentChanged: true });
    const p = await prepared(await importEntry(id, "superpowers"));
    expect(p.review.version).toBe(`7.0.1+git.${moved.slice(0, 12)}`);
    expect(p.review.pluginVersion).toBe("7.0.1");
  });

  it("phase D: a version imported before the command translation is new content when re-imported (+git.<sha12>)", async () => {
    const head = await srv.commit("sp-redo", loadFixtureAsStrings("superpowers"));
    const first = await prepared(await importGit({ url: srv.url("sp-redo") }));
    expect(first.review.version).toBe("7.0.1");
    expect((await confirm(first)).statusCode).toBe(201);
    // the same content again is already imported
    const again = await importGit({ url: srv.url("sp-redo") });
    expect(again.statusCode, again.body).toBe(409);
    // as if 7.0.1 had been imported before phase D: its digest was the files' own
    await db
      .updateTable("catalog_item_versions")
      .set({ content_digest: contentDigest(loadFixture("superpowers")) })
      .where("version", "=", "7.0.1")
      .execute();
    // the existing rule (recordedVersion): the commit's build metadata first, as for any other
    // content at an imported version of a git source; +sha256.<12> only when that is taken too
    const redo = await prepared(await importGit({ url: srv.url("sp-redo") }));
    expect(redo.review.version).toBe(`7.0.1+git.${head.slice(0, 12)}`);
    expect(redo.review.skills.map((x) => x.name)).toContain("brainstorm");
  });

  it("phase D batch 1 review M3 / I4: a skill with a wrong-typed invocation key and a command with Claude's argument-hint form import", async () => {
    await srv.commit("typed", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "typed", version: "1.0.0" }),
      "skills/one/SKILL.md":
        '---\nname: one\ndescription: One.\ndisable-model-invocation: "true"\n---\nOne.\n',
      "commands/triage.md":
        "---\ndescription: Triage.\nargument-hint: [pr-number] [priority] [assignee]\n---\nTriage $ARGUMENTS.\n",
    });
    const p = await prepared(await importGit({ url: srv.url("typed") }));
    expect(p.review.skills.map((x) => x.name).sort()).toEqual(["one", "triage"]);
    expect(groups(p.review.translation as TranslationReport).warnings).toEqual([
      "skill_invocation_key_ignored one",
    ]);
    expect((await confirm(p)).statusCode).toBe(201);
  });

  // review I4: an entry-only change at the same version is new content. Two tests (one per entry
  // kind) so that each does a handful of git round trips, like its neighbours.
  const soloPlugin = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "solo", version: "1.0.0" }),
    "skills/one/SKILL.md": SKILL_MD("one"),
  };
  const entryHooks = { Stop: [{ hooks: [{ type: "command", command: "true" }] }] };
  const soloMkt = (entry: Record<string, unknown>) =>
    JSON.stringify({ name: "acme", owner: { name: "Acme" }, plugins: [entry] });

  it("an entry-only change at the same version is new content (review I4): a path entry -> +git.<sha12>", async () => {
    const plugin = soloPlugin;
    const mkt = soloMkt;
    const nested = (entry: Record<string, unknown>) => ({
      ".claude-plugin/marketplace.json": mkt(entry),
      ...Object.fromEntries(Object.entries(plugin).map(([p, v]) => [`solo/${p}`, v])),
    });
    // a path entry: the plugin's files are unchanged, the marketplace file is not in its subtree
    await srv.commit("overlay", nested({ name: "solo", source: "./solo" }));
    const id = await addGit("overlay");
    const first = await prepared(await importEntry(id, "solo"));
    expect((await confirm(first)).statusCode).toBe(201);
    const moved = await srv.commit(
      "overlay",
      nested({ name: "solo", source: "./solo", hooks: entryHooks }),
    );
    await refresh(id);
    const second = await prepared(await importEntry(id, "solo"));
    expect(second.review.version).toBe(`1.0.0+git.${moved.slice(0, 12)}`);
    expect(second.review.contentDigest).not.toBe(first.review.contentDigest);
    expect(second.review.reviewHash).not.toBe(first.review.reviewHash);
    expect(
      second.review.translation?.items.some((i) => i.code === "hooks_not_run" && i.name === "Stop"),
    ).toBe(true);
    // without entry components the digest is the files' own (a direct git import matches it)
    expect(first.review.contentDigest).toBe(
      contentDigest(new Map(Object.entries(plugin).map(([p, v]) => [p, Buffer.from(v)]))),
    );
  });

  it("an entry-only change at the same version is new content (review I4): an other-repo entry -> +git.<sha12>, then +sha256.<12>", async () => {
    const plugin = soloPlugin;
    const mkt = soloMkt;
    // an entry in another repository: the plugin's commit stays, only the entry changes
    const head = await srv.commit("solo-repo", plugin);
    const remote = (extra: Record<string, unknown>) =>
      srv.commit("remote-mkt", {
        ".claude-plugin/marketplace.json": mkt({
          name: "solo",
          source: { source: "url", url: srv.url("solo-repo") },
          ...extra,
        }),
      });
    await remote({});
    const rid = await addGit("remote-mkt");
    expect((await confirm(await prepared(await importEntry(rid, "solo")))).statusCode).toBe(201);
    await remote({ hooks: entryHooks });
    await refresh(rid);
    const r2 = await prepared(await importEntry(rid, "solo"));
    expect(r2.review.version).toBe(`1.0.0+git.${head.slice(0, 12)}`);
    expect((await confirm(r2)).statusCode).toBe(201);
    await remote({ hooks: entryHooks, skills: ["./skills/one"] });
    await refresh(rid);
    const r3 = await prepared(await importEntry(rid, "solo"));
    expect(r3.review.version).toBe(`1.0.0+sha256.${r3.review.contentDigest.slice(0, 12)}`);
    // the same entry again is already imported
    expect((await confirm(r3)).statusCode).toBe(201);
    const again = await importEntry(rid, "solo");
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe("catalog.version_exists");
  });

  it("a strict:false conflict is catalog.invalid_manifest naming the entry", async () => {
    await srv.commit("conflict", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "acme",
        owner: { name: "Acme" },
        plugins: [{ name: "clash", source: "./clash", strict: false, skills: ["./extra"] }],
      }),
      "clash/.claude-plugin/plugin.json": JSON.stringify({
        name: "clash",
        version: "1.0.0",
        skills: "./more",
      }),
      "clash/more/one/SKILL.md": SKILL_MD("one"),
      "clash/extra/SKILL.md": SKILL_MD("extra"),
    });
    const id = await addGit("conflict");
    const res = await importEntry(id, "clash");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("catalog.invalid_manifest");
    expect(res.json().error.message).toContain(
      "marketplace entry clash sets strict: false and declares components that plugin.json declares too",
    );
  });

  it("a tgz with only .claude-plugin/plugin.json stays catalog.invalid_manifest (Decisions 11)", async () => {
    const tgz = await packPackageTgz(
      new Map([
        ["package.json", Buffer.from(JSON.stringify({ name: "solo", version: "1.0.0" }))],
        [".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "solo" }))],
        ["skills/solo/SKILL.md", Buffer.from(SKILL_MD("solo"))],
      ]),
    );
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(tgz),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("catalog.invalid_manifest");
    expect(res.json().error.message).toContain(".capybara-plugin/plugin.json not found");
  });
});
