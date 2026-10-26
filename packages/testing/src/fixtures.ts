import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fake extensions, one or more per extension point, that core tests load instead of the official
 * plugins (they live in `fixtures/extensions/<name>` of this package, in the pack layout:
 * `package.json`, `.capybara-plugin/plugin.json`, `src/index.ts`, plus `migrations/`, `skills/`,
 * `connectors/` where they have them). Each imports only `@capybara-hq/plugin-sdk`, zod and
 * third-party packages this package depends on.
 *
 * | name | provides / covers |
 * |---|---|
 * | `fake-connector` | `connector@1` kind `fake`: an MCP client for `startFakeMcpServer` (auth, one 401 retry, connectorData routes from `_meta["fake/route"]`, onToolsChanged, onElicit incl. `-32042`, resources, prompts, inspect); endpoint `{ url, headers?, notesText? }`; template `fake-demo`; deployment config `allowInsecureLoopback` (default true), `inspectAuth` (`bearer` / `api_key`) |
 * | `fake-object-store` | `object-store@1` on the `startTestS3()` container (deployment config as `TestS3` gives it; POST-policy presign) |
 * | `fake-tools-ui` | tool `write`, view `tasks`, a migration, skill `fake-notes`, template `fake-notes` (for fake-connector); no storage |
 * | `fake-storage-user` | tools `note` / `read_note` through `ctx.storage` (`permissions.storage`) |
 * | `fake-embed` | embeds `panel` (page) and `panel-conv` (conversation), static `/ui/panel.js`, token-checked routes, SSE over `ctx.bus` |
 * | `fake-bootstrap-a` | `model-provider@2` with a required secret `apiKey` (pending configuration until set) |
 * | `fake-bootstrap-b` | `object-store@1` kept in its own PG table; `bucket` + secret `secretKey` |
 * | `fake-dep-provider` / `fake-dep-requirer` | a dependency pair on `counter@1` (the requirer's plugin.json depends on the provider) |
 */
export const FAKE_EXTENSIONS = [
  "fake-connector",
  "fake-object-store",
  "fake-tools-ui",
  "fake-storage-user",
  "fake-embed",
  "fake-bootstrap-a",
  "fake-bootstrap-b",
  "fake-dep-provider",
  "fake-dep-requirer",
] as const;

/** The name of a fake extension (also its plugin and extension name). */
export type FakeExtensionName = (typeof FAKE_EXTENSIONS)[number];

/** `fixtures/extensions/` of this package (same path from `src/` and from `dist/`). */
const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/extensions/", import.meta.url));

/** The plugin directory of a fake (pack layout), for `packFixture` or a packer of your own. */
export function fakeExtensionDir(name: FakeExtensionName): string {
  return join(FIXTURES_DIR, name);
}

/**
 * The extension entry `src/index.ts` of a fake, for kernel configs that load extensions by path
 * (`extensions: [fakeExtensionEntry("fake-connector")]`). Loading TypeScript by path works in this
 * repository's tests; a consumer that installs this package from npm should pack the fake with
 * {@link packFixture} instead (Node does not strip types under node_modules).
 */
export function fakeExtensionEntry(name: FakeExtensionName): string {
  return join(FIXTURES_DIR, name, "src/index.ts");
}

/** The result of {@link packFixture}. */
export interface PackedFixture {
  /** Path of the tgz in `outDir`. */
  file: string;
  bytes: Uint8Array;
  /** Hex sha256 of the tgz. */
  sha256: string;
}

/** The packer's interface as used here (`packPlugin` of the plugin packer). */
type Packer = (dir: string, outDir: string) => Promise<{ file: string; sha256: string }>;

/**
 * The plugin packer, imported lazily so only callers of {@link packFixture} need it. Today that is
 * the workspace package `@capybara-hq/pack-plugin` (a devDependency of this package); the
 * specifier is a variable so TypeScript does not pull the packer into this package's build.
 */
const PACKER_MODULE = "@capybara-hq/pack-plugin";

async function packer(): Promise<Packer> {
  const mod = (await import(PACKER_MODULE)) as { packPlugin?: Packer };
  if (typeof mod.packPlugin !== "function") {
    throw new Error(`${PACKER_MODULE} has no packPlugin export`);
  }
  return mod.packPlugin;
}

/**
 * Packs a fake extension into a plugin tgz with the plugin packer (the same bytes `pnpm
 * pack-plugin` would produce: single-file ESM bundle, static manifest in plugin.json, migrations,
 * skills and templates), writes it to `outDir` and returns its path, bytes and sha256. Packing
 * leaves no files in the fixture directory.
 */
export async function packFixture(name: FakeExtensionName, outDir: string): Promise<PackedFixture> {
  if (!FAKE_EXTENSIONS.includes(name)) throw new Error(`unknown fake extension ${String(name)}`);
  const pack = await packer();
  const r = await pack(fakeExtensionDir(name), outDir);
  return { file: r.file, bytes: new Uint8Array(await readFile(r.file)), sha256: r.sha256 };
}
