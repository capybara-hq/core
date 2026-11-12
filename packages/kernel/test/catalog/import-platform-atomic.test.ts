import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformComponents, type PreparedSync } from "../../src/catalog/platform-components.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { SKILL_MD } from "../skills/zip.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, startOrgEnv } from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillFiles } from "./packages.js";

/**
 * Transactional outbox Task 15 (spec §8.1, design review `catalog-import-heal-job`): a plugin
 * import writes its platform component rows in the import's transaction. The files are copied
 * before it, keyed by content, so a failed import leaves no item, no rows and nothing a retry
 * would copy again; no job heals an item afterwards.
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
  vi.restoreAllMocks();
});

/** Plugin `kit`: skills alpha and beta, agent template reviewer, connector template kit-mcp. */
const kit = () =>
  bundlePlugin({
    name: "kit",
    version: "1.0.0",
    skills: ["beta"],
    templates: { "kit-mcp": mcpTemplate() },
    files: {
      ...skillFiles("alpha", SKILL_MD("alpha", "Alpha things.")),
      "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews kit work.\n---\nReview.\n",
    },
  });

async function prepare(): Promise<{ stagingId: string; reviewHash: string }> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(await kit()),
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { stagingId: string; review: { reviewHash: string } };
  return { stagingId: body.stagingId, reviewHash: body.review.reviewHash };
}

const confirm = (p: { stagingId: string; reviewHash: string }) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${p.stagingId}/confirm`,
    payload: { reviewHash: p.reviewHash },
  });

/** Every object under the platform components' prefix. */
async function platformObjects(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.k.app
      .get(StorageService)
      .deployment()
      .list("platform/", cursor === undefined ? {} : { cursor });
    keys.push(...page.items.map((o) => o.key));
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

/** The object prefixes the platform version rows reference. */
async function referencedPrefixes(): Promise<string[]> {
  const skills = await env.db
    .selectFrom("platform_skill_versions")
    .select("object_prefix")
    .execute();
  const agents = await env.db
    .selectFrom("platform_agent_template_versions")
    .select("object_prefix")
    .execute();
  return [...skills, ...agents]
    .flatMap((r) => (r.object_prefix === null ? [] : [r.object_prefix]))
    .sort();
}

/** The platform rows of the import fail after they are written, in its transaction. */
function failPlatformWrite(): void {
  const original = PlatformComponents.prototype.applySyncIn;
  vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockImplementationOnce(async function (
    this: PlatformComponents,
    p: PreparedSync,
  ) {
    await original.call(this, p);
    throw new Error("injected platform write failure");
  });
}

const kitItem = () =>
  env.db
    .selectFrom("catalog_items")
    .select(["id", "platform_synced_version"])
    .where("name", "=", "kit")
    .where("deleted_at", "is", null)
    .executeTakeFirst();

describe("platform components in the import's transaction", { timeout: 120_000 }, () => {
  it("a failure writing platform components rolls the import back", async () => {
    const p = await prepare();
    failPlatformWrite();
    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(500);
    // nothing of the import committed: no item, no version, no platform rows; the staging stays
    expect(await kitItem()).toBeUndefined();
    expect(await env.db.selectFrom("catalog_item_versions").select("item_id").execute()).toEqual(
      [],
    );
    expect(await env.db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_agent_templates").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_connector_templates").select("id").execute()).toEqual(
      [],
    );
    expect(
      await env.db
        .selectFrom("plugin_import_staging")
        .select("id")
        .where("id", "=", p.stagingId)
        .executeTakeFirst(),
    ).toEqual({ id: p.stagingId });
  });

  it("retrying the import after that failure succeeds and writes no duplicate objects", async () => {
    const first = await prepare();
    failPlatformWrite();
    expect((await confirm(first)).statusCode).toBe(500);
    // the files were copied before the transaction: they stay, keyed by their content
    const copied = await platformObjects();
    // alpha and beta (SKILL.md and scripts/run.py each), the reviewer template
    expect(copied.length).toBe(5);

    // the same staging confirmed again
    const again = await confirm(first);
    expect(again.statusCode, again.body).toBe(201);
    expect(await platformObjects()).toEqual(copied);
    // every object is one a version row references
    const prefixes = await referencedPrefixes();
    expect(prefixes).toHaveLength(3);
    for (const key of copied) expect(prefixes.some((p) => key.startsWith(p))).toBe(true);

    // a fresh prepare of the same content after a failure reuses the objects too
    await resetOrgCatalog(env);
    const before = await prepare();
    failPlatformWrite();
    expect((await confirm(before)).statusCode).toBe(500);
    const copiedAgain = await platformObjects();
    const fresh = await prepare();
    const c = await confirm(fresh);
    expect(c.statusCode, c.body).toBe(201);
    expect(await platformObjects()).toEqual(copiedAgain);
  });

  it("an imported item has its platform rows when the import returns", async () => {
    const itemId = await importPlugin(env, await kit());
    expect(await kitItem()).toEqual({ id: itemId, platform_synced_version: "1.0.0" });
    const names = async (table: "platform_skills" | "platform_agent_templates") =>
      (
        await env.db
          .selectFrom(table)
          .select("name")
          .where("catalog_item_id", "=", itemId)
          .orderBy("name")
          .execute()
      ).map((r) => r.name);
    expect(await names("platform_skills")).toEqual(["alpha", "beta"]);
    expect(await names("platform_agent_templates")).toEqual(["reviewer"]);
    expect(
      (
        await env.db
          .selectFrom("platform_connector_templates")
          .select("template_id")
          .where("catalog_item_id", "=", itemId)
          .execute()
      ).map((r) => r.template_id),
    ).toEqual(["kit-mcp"]);
  });
});
