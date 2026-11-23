import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type BootstrapManifest, parseBootstrapManifest } from "@capybara-hq/plugin-sdk";

/**
 * The built-in bootstrap manifest: where it ships, how it is read and its run identity (spec
 * 2026-11-20-bootstrap-extra-manifest §3). Shared by the kernel start and `capybara bootstrap`;
 * merging an extra manifest into it is `bootstrap-extra.ts`.
 */
/** The bootstrap manifest that ships with the kernel package. */
export const BOOTSTRAP_MANIFEST_FILE = fileURLToPath(
  new URL("../../bootstrap.json", import.meta.url),
);

/** sha256 (hex) of a manifest: of its JSON text as parsed (key order kept). */
export function bootstrapManifestSha256(
  manifest: Omit<BootstrapManifest, "plugins"> & { plugins: readonly object[] },
): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/** Reads and parses a bootstrap manifest file; an invalid one throws with its problems. */
export async function readBootstrapManifest(
  file: string = BOOTSTRAP_MANIFEST_FILE,
): Promise<BootstrapManifest> {
  const parsed = parseBootstrapManifest(JSON.parse(await readFile(file, "utf8")));
  if ("errors" in parsed) {
    throw new Error(`invalid bootstrap manifest ${file}: ${parsed.errors.join("; ")}`);
  }
  return parsed;
}
