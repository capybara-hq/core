import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The SDK source that declares `SDK_VERSION`, and the package.json it must follow. */
export const SDK_SOURCE = "packages/plugin-sdk/src/index.ts";
const SDK_PACKAGE_JSON = "packages/plugin-sdk/package.json";
const DECL = /^export const SDK_VERSION = "([^"]*)";$/m;

/**
 * Sets `SDK_VERSION` in the SDK source to the SDK's package.json version (run by
 * `pnpm version-packages` after `changeset version`; plugin-sdk's smoke test requires them equal).
 */
export function syncSdkVersion(root: string): { changed: boolean; version: string } {
  const version = String(
    (JSON.parse(readFileSync(join(root, SDK_PACKAGE_JSON), "utf8")) as { version?: unknown })
      .version,
  );
  const file = join(root, SDK_SOURCE);
  const src = readFileSync(file, "utf8");
  const m = DECL.exec(src);
  if (m === null) throw new Error(`${SDK_SOURCE}: no \`export const SDK_VERSION = "...";\``);
  if (m[1] === version) return { changed: false, version };
  writeFileSync(file, src.replace(DECL, `export const SDK_VERSION = ${JSON.stringify(version)};`));
  return { changed: true, version };
}
