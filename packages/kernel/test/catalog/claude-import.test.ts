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
import type { TranslationReport } from "../../src/catalog/claude/report.js";
import { contentDigest } from "../../src/catalog/plugin-package.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { packPackageTgz } from "../../src/packages/tgz.js";
import { truncateTables } from "../helpers/db.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { loadFixture, loadFixtureAsStrings } from "./claude-fixtures.js";

/** The one import review for Claude Code plugins (spec §8): git marketplaces and direct git imports. */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let k: Kernel;
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
  k = await createKernel(config, { env: {} });
  await k.start();
  await new AccountsService(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
}, 240_000);

afterAll(async () => {
  await k?.stop();
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
    "skill_imported test-driven-development",
    "skill_imported using-superpowers",
    "skill_imported writing-plans",
  ],
  converted: [],
  needsInput: [],
  ignored: [
    "command_manual_invocation brainstorm",
    "agent_needs_subagents code-reviewer",
    "hooks_not_run SessionStart",
    "other_harness .codex-plugin",
  ],
  warnings: ["session_start_pin_hint SessionStart"],
};

describe("importing Claude Code plugins", () => {
  it("importing superpowers from its Claude marketplace: format claude-code, no extension, report groups, license text, 4 skills with suggestPinned false", async () => {
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
    expect(r.translation?.sessionStart).toBe(true);
    expect(r.translation?.manifestPath).toBe(".claude-plugin/plugin.json");
    expect(groups(r.translation as TranslationReport)).toEqual(SUPERPOWERS_GROUPS);
    expect(r.skills.map((s) => [s.name, s.suggestPinned])).toEqual([
      ["brainstorming", false],
      ["test-driven-development", false],
      ["using-superpowers", false],
      ["writing-plans", false],
    ]);
    // the digest is over the files as read (Review Focus 5)
    expect(r.contentDigest).toBe(contentDigest(loadFixture("superpowers")));
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
      { path: "./skills/test-driven-development" },
      { path: "./skills/using-superpowers", pinned: true },
      { path: "./skills/writing-plans" },
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

  it("the reviewHash changes when the report changes (one more hook) and confirm with the old hash is plugin.review_stale", async () => {
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
