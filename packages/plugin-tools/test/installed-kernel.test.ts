import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packPlugin } from "../src/pack/index.js";
import { linkDeps, REPO as repo, runVitest, statuses } from "./installed-support.js";

/**
 * A plugin repository's view of core (phase A3b, Step 1b and Decision 2): the kernel and the SDK
 * come from `node_modules` as built packages and `@capybara-hq/plugin-model-fake` is installed from
 * its plugin tgz. Two things must hold there:
 * - a packed plugin resolves by package name (`createRequire(...).resolve(name)`, which the kernel's
 *   loader uses for a name in `extensions`), and the kernel loads it;
 * - the kernel loads a TypeScript plugin under test by path (`plugins/<name>/src/index.ts`, whose
 *   imports say `./x.js`). From `node_modules` vitest externalizes the kernel, so its `import(url)`
 *   runs in plain Node, which strips types but does not map `./x.js` to `./x.ts`: loading fails.
 *   The plugins repository's vitest config inlines the core packages
 *   ({@link PLUGIN_REPO_INLINE}), so Vite transforms the kernel and its dynamic import.
 *
 * The temp repository is built here: esbuild bundles of the kernel and SDK sources (stand-ins for
 * their npm builds), symlinks to the workspace's third-party dependencies, model-fake packed with
 * `packPlugin`; then vitest runs a test inside it as a child process, with and without inlining.
 */

/**
 * The pattern the plugins repository's `vitest.config.ts` puts in `test.server.deps.inline`.
 * Vitest matches it against the resolved file path, not the package name, so the plan's
 * `/^@capybara-hq\//` matches nothing.
 */
const PLUGIN_REPO_INLINE = String.raw`/\/node_modules\/@capybara-hq\//`;

const run = promisify(execFile);
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";

let dir: string;

/** A core library as its npm build would install it: `dist/index.js` (one bundle) and package.json. */
async function installLibrary(nm: string, name: string, pkgDir: string): Promise<void> {
  const out = join(nm, name);
  const pkg = JSON.parse(await readFile(join(repo, pkgDir, "package.json"), "utf8")) as {
    version: string;
  };
  await build({
    entryPoints: [join(repo, pkgDir, "src/index.ts")],
    outfile: join(out, "dist/index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    tsconfig: join(repo, pkgDir, "tsconfig.json"),
    logLevel: "error",
  });
  await writeFile(
    join(out, "package.json"),
    JSON.stringify({
      name,
      version: pkg.version,
      type: "module",
      main: "./dist/index.js",
      exports: { ".": "./dist/index.js" },
    }),
  );
}

const LOAD_TEST = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "@capybara-hq/kernel";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

it("resolves model-fake by package name", () => {
  expect(createRequire(root + "noop.js").resolve("${MODEL_FAKE}")).toBe(
    root + "node_modules/${MODEL_FAKE}/dist/index.mjs",
  );
});

it("loads model-fake by package name", async () => {
  const r = await ExtensionHost.inspect(["${MODEL_FAKE}"], { resolveFrom: root });
  expect(r.map((x) => x.manifest.name)).toEqual(["model-fake"]);
});

it("loads a TypeScript plugin by path", async () => {
  const r = await ExtensionHost.inspect([root + "plugins/demo/src/index.ts"], { resolveFrom: root });
  expect(r.map((x) => x.manifest.name)).toEqual(["demo"]);
});
`;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "installed-kernel-")));
  const nm = join(dir, "node_modules");
  await mkdir(nm, { recursive: true });
  for (const d of ["packages/kernel", "packages/plugin-sdk", "."]) {
    await linkDeps(join(repo, d, "node_modules"), nm);
  }
  await installLibrary(nm, "@capybara-hq/plugin-sdk", "packages/plugin-sdk");
  await installLibrary(nm, "@capybara-hq/kernel", "packages/kernel");
  const packed = await packPlugin(join(repo, "plugins/model-fake"), join(dir, "packs"));
  await mkdir(join(nm, MODEL_FAKE), { recursive: true });
  await run("tar", ["-xzf", packed.file, "-C", join(nm, MODEL_FAKE), "--strip-components=1"]);

  await mkdir(join(dir, "plugins/demo/src"), { recursive: true });
  await writeFile(join(dir, "plugins/demo/src/name.ts"), 'export const NAME: string = "demo";\n');
  await writeFile(
    join(dir, "plugins/demo/src/index.ts"),
    [
      'import { defineExtension } from "@capybara-hq/plugin-sdk";',
      'import { NAME } from "./name.js";',
      "",
      'export default defineExtension({ name: NAME, version: "0.1.0", sdk: "^0.1.0-rc.0", provides: [], setup() {} });',
      "",
    ].join("\n"),
  );
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(join(dir, "test/load.test.ts"), LOAD_TEST);
  const config = (inline: string) =>
    `export default { test: { include: ["test/**/*.test.ts"]${inline} } };\n`;
  await writeFile(join(dir, "vitest.plain.config.mjs"), config(""));
  await writeFile(
    join(dir, "vitest.inline.config.mjs"),
    config(`, server: { deps: { inline: [${PLUGIN_REPO_INLINE}] } }`),
  );
}, 120_000);

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

/** Runs vitest inside the temp repository with one of its configs. */
const vitest = (config: "plain" | "inline") =>
  runVitest(dir, join(dir, `vitest.${config}.config.mjs`));

describe("a plugin repository with the kernel from node_modules", () => {
  it("without inlining, a TypeScript plugin by path fails to load; model-fake by name loads", async () => {
    const r = await vitest("plain");
    expect(r.code, r.output).not.toBe(0);
    expect(statuses(r.tests), r.output).toEqual({
      "resolves model-fake by package name": "passed",
      "loads model-fake by package name": "passed",
      "loads a TypeScript plugin by path": "failed",
    });
    const failed = r.tests.find((t) => t.status === "failed");
    expect(failed?.failureMessages.join("\n")).toContain("plugins/demo/src/name.js");
  }, 120_000);

  it("with the core packages inlined, both load", async () => {
    const r = await vitest("inline");
    expect(r.code, r.output).toBe(0);
    expect(statuses(r.tests), r.output).toEqual({
      "resolves model-fake by package name": "passed",
      "loads model-fake by package name": "passed",
      "loads a TypeScript plugin by path": "passed",
    });
  }, 120_000);
});
