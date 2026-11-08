import { createHash } from "node:crypto";
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
