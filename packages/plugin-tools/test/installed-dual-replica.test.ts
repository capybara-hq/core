import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCompiled, linkDeps, REPO, runVitest, statuses } from "./installed-support.js";

/**
 * A plugin repository's dual-replica tests with core from npm (phase A3b). The kernel, the SDK and
 * `@capybara-hq/testing` are installed under `node_modules` as their compiled npm builds, and a
 * test runs `createDualReplicaHarness` on a TypeScript plugin by path (`plugins/demo/src/index.ts`,
 * importing `./name.js`) and on a fake extension that testing ships as TypeScript under
 * `node_modules` (`fakeExtensionEntry`). Each replica is a plain `node` child process, outside
 * vitest's transforms, so the harness itself must make both loadable: plain Node neither maps
 * `./name.js` to `./name.ts` nor strips types under `node_modules`. No `NODE_OPTIONS` reaches the
 * child run, so nothing but the harness can help.
 */

let dir: string;

const TS_PLUGIN = "loads a TypeScript plugin by path";
const FAKE = "loads a fake extension of @capybara-hq/testing";

const DUAL_TEST = `import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, fakeExtensionEntry, startTestRedis } from "@capybara-hq/testing";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Starts two replicas loading \`extension\` and checks both answer. */
async function smoke(extension: string): Promise<void> {
  const redis = await startTestRedis({ shared: true });
  try {
    const h = await createDualReplicaHarness({
      extensions: [extension],
      resolveFrom: root,
      redisUrl: redis.url,
    });
    try {
      for (const i of [0, 1]) expect((await h.requestTo(i, "/healthz")).status).toBe(200);
    } finally {
      await h.stop();
    }
  } finally {
    await redis.stop();
  }
}

it("${TS_PLUGIN}", () => smoke(root + "plugins/demo/src/index.ts"));

it("${FAKE}", () => smoke(fakeExtensionEntry("fake-tools-ui")));
`;

/** The plugins repository's vitest config: the core packages inlined (plugin-tools README). */
const INLINE_CONFIG = String.raw`export default {
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    server: { deps: { inline: [/\/node_modules\/@capybara-hq\//] } },
  },
};
`;

/** The same without inlining: `@capybara-hq/testing` runs natively in the vitest worker. */
const PLAIN_CONFIG = `export default { test: { include: ["test/**/*.test.ts"], testTimeout: 120_000 } };\n`;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "installed-dual-")));
  const nm = join(dir, "node_modules");
  await mkdir(nm, { recursive: true });
  for (const d of ["packages/testing", "packages/kernel", "packages/plugin-sdk", "."]) {
    await linkDeps(join(REPO, d, "node_modules"), nm);
  }
  await installCompiled(nm, "@capybara-hq/plugin-sdk", "packages/plugin-sdk");
  await installCompiled(nm, "@capybara-hq/kernel", "packages/kernel", [
    "src/migrations",
    "bootstrap.json",
  ]);
  await installCompiled(nm, "@capybara-hq/testing", "packages/testing", ["fixtures"]);

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
  await writeFile(join(dir, "test/dual.test.ts"), DUAL_TEST);
  await writeFile(join(dir, "vitest.inline.config.mjs"), INLINE_CONFIG);
  await writeFile(join(dir, "vitest.plain.config.mjs"), PLAIN_CONFIG);
}, 120_000);

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

/** The child's environment: no `NODE_OPTIONS` (a loader there would hide what the harness lacks). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "" };
  delete env.NODE_OPTIONS;
  return env;
}

describe("a plugin repository's dual-replica test with core from node_modules", () => {
  for (const config of ["inline", "plain"] as const) {
    it(`starts both replicas (${config} config)`, async () => {
      const r = await runVitest(dir, join(dir, `vitest.${config}.config.mjs`), childEnv());
      expect(statuses(r.tests), r.output + r.tests.flatMap((t) => t.failureMessages)).toEqual({
        [TS_PLUGIN]: "passed",
        [FAKE]: "passed",
      });
      expect(r.code, r.output).toBe(0);
    }, 300_000);
  }
});
