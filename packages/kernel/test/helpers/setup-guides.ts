import { createHash, randomUUID } from "node:crypto";
import { putDisplayFiles } from "../../src/catalog/catalog-files.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";

/**
 * A channel guide document whose long-connection and webhook manifests are `socket` and `webhook`
 * (each a line of YAML): changing one moves the drift hash of that mode only.
 */
export const channelGuideDoc = (socket: string, webhook: string): string =>
  [
    "# Create the app",
    "",
    "::: mode long_connection",
    "```yaml",
    `socket: ${socket}`,
    "```",
    ":::",
    "",
    "::: mode webhook",
    "```yaml",
    `webhook: ${webhook}`,
    "```",
    ":::",
    "",
  ].join("\n");

/**
 * Stores setup guide documents as catalog display files (as an import does) and returns the file
 * list a version row records for them, for tests that seed catalog versions directly.
 */
export async function seedGuideFiles(
  db: KernelSchemaDb,
  docs: Record<string, string>,
): Promise<{ path: string; size: number; sha256: string }[]> {
  const files = Object.entries(docs).map(([path, text]) => {
    const data = new TextEncoder().encode(text);
    return {
      path,
      data,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
  await putDisplayFiles(db, files);
  return files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
}

/**
 * fake-im's channel guide with the fixture's setup checks (`fake-im/src/checks.ts`): the long
 * connection mode lists every check plus `missing` (an id the extension never registers); `fail`
 * is in the webhook mode only.
 */
export const FAKE_IM_CHECKS_GUIDE = [
  "# Create the fake IM app",
  "",
  "::: mode long_connection",
  "```yaml",
  "socket: true",
  "```",
  "",
  "::check pass The platform accepts the app",
  "::check proxy The platform answers",
  "::check throw A check that throws",
  "::check hang A slow check",
  "::check ignore-signal A check that ignores its signal",
  "::check long A check with a long reason",
  "::check echo-secret A check that echoes the secret",
  "::check pad-to-limit A check at the reason limit",
  "::check missing A check the plugin does not register",
  ":::",
  "",
  "::: mode webhook",
  "```yaml",
  "webhook: true",
  "```",
  "",
  "::check fail The platform refuses the app",
  ":::",
  "",
].join("\n");

/**
 * Seeds the catalog item `fake-im` (scope all) whose latest version has the guide `fake-im-app`
 * ({@link FAKE_IM_CHECKS_GUIDE}); returns the item id.
 */
export async function seedFakeImGuideItem(db: KernelSchemaDb): Promise<string> {
  const itemId = randomUUID();
  const files = await seedGuideFiles(db, { "guides/fake-im-app.md": FAKE_IM_CHECKS_GUIDE });
  await db
    .insertInto("catalog_items")
    .values({
      id: itemId,
      name: "fake-im",
      package_name: "@capybara-hq/test-plugin-fake-im",
      publisher: "Capybara",
      description: "Test fake",
      latest_version: "0.1.0",
      policy: "allow",
      disabled: false,
    })
    .execute();
  await db
    .insertInto("catalog_item_versions")
    .values({
      item_id: itemId,
      version: "0.1.0",
      manifest: JSON.stringify({
        schemaVersion: 1,
        name: "fake-im",
        version: "0.1.0",
        publisher: "Capybara",
        description: "Test fake",
        setupGuides: [{ id: "fake-im-app", place: "channel-connection" }],
      }),
      source: "file",
      source_ref: "upload",
      object_prefix: null,
      files: JSON.stringify(files),
      size: 1000,
    })
    .execute();
  return itemId;
}
