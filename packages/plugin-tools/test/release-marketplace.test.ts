import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeNpmRegistry, startFakeNpmRegistry } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrityOf } from "../src/integrity.js";
import { packPlugin } from "../src/pack/index.js";
import { ReleaseIntegrityError, runPublish } from "../src/release/index.js";

const fixture = fileURLToPath(new URL("./fixtures/declarative", import.meta.url));

let root: string;
let reg: FakeNpmRegistry;
/** Each plugin's pack integrity (`plugins/<x>` -> sha512 SRI). */
const packed = new Map<string, string>();
const PLUGINS = ["a", "b", "c", "d"];
const pkgName = (x: string) => `@capybara-hq/plugin-rel-${x}`;

/** A public declarative plugin `plugins/<x>` named `rel-<x>` (copied from the fixture). */
function addPlugin(x: string): void {
  const dir = join(root, "plugins", x);
  cpSync(fixture, dir, { recursive: true });
  const pj = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
  writeFileSync(pj, JSON.stringify({ ...pkg, name: pkgName(x), private: false }));
  const mf = join(dir, ".capybara-plugin/plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8")) as Record<string, unknown>;
  writeFileSync(mf, JSON.stringify({ ...m, name: `rel-${x}` }));
}

const entry = (x: string, integrity: string) => ({
  name: `rel-${x}`,
  summary: { en: x },
  source: { npm: { package: pkgName(x), version: "0.1.0", integrity } },
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "release-marketplace-")));
  for (const x of PLUGINS) {
    addPlugin(x);
    const r = await packPlugin(join(root, "plugins", x), join(root, "ref"));
    packed.set(x, integrityOf(new Uint8Array(await readFile(r.file))));
  }
  // rel-a 0.1.0 is already on the registry: skipped, never packed against the marketplace
  reg = await startFakeNpmRegistry({
    packages: [
      {
        name: pkgName("a"),
        version: "0.1.0",
        tgz: new Uint8Array(await readFile(join(root, "ref/capybara-hq-plugin-rel-a-0.1.0.tgz"))),
      },
    ],
  });
  vi.stubEnv("NPM_CONFIG_REGISTRY", reg.url);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await reg?.stop();
  await rm(root, { recursive: true, force: true });
});

/** A release (not a dry run) against the fake registry, recording every `npm publish`. */
async function release(marketplace: object, opts: { plugins?: string } = {}) {
  const file = join(root, "marketplace.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "test", ...marketplace }));
  const published: string[] = [];
  const run = runPublish({
    dryRun: false,
    provenance: true,
    out: join(root, "out"),
    root,
    marketplace: file,
    ...opts,
    exec: async (cmd, args) => {
      if (cmd === "npm" && args[0] === "publish") published.push(args[1]?.split("/").pop() ?? "");
    },
  });
  return { run, published };
}

describe("capybara-plugin release --marketplace", () => {
  it("publishes the packs whose sha512 equals their marketplace entry", async () => {
    const { run, published } = await release({
      plugins: ["b", "c", "d"].map((x) => entry(x, packed.get(x) as string)),
    });
    expect((await run).published).toEqual(["b", "c", "d"].map((x) => `${pkgName(x)}@0.1.0`));
    expect(published).toEqual(["b", "c", "d"].map((x) => `capybara-hq-plugin-rel-${x}-0.1.0.tgz`));
    expect(reg.requests).toContain(`/${pkgName("a").replace("/", "%2f")}`);
  }, 60_000);

  it("stops at a pack that differs from its entry, publishing nothing after the previous package", async () => {
    const wrong = `sha512-${"C".repeat(86)}==`;
    const { run, published } = await release({
      plugins: [
        entry("b", packed.get("b") as string),
        entry("c", wrong),
        entry("d", packed.get("d") as string),
      ],
    });
    const err = await run.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReleaseIntegrityError);
    expect((err as ReleaseIntegrityError).code).toBe("release.integrity_mismatch");
    expect((err as Error).message).toContain(`${pkgName("c")}@0.1.0`);
    expect((err as Error).message).toContain(packed.get("c"));
    expect((err as Error).message).toContain(wrong);
    expect(published).toEqual(["capybara-hq-plugin-rel-b-0.1.0.tgz"]);
  }, 60_000);

  it("stops at a plugin version the marketplace does not list", async () => {
    const { run, published } = await release({
      plugins: [entry("b", packed.get("b") as string)],
    });
    await expect(run).rejects.toThrow(
      /release\.integrity_mismatch: .*rel-c@0\.1\.0.* no npm entry/,
    );
    expect(published).toEqual(["capybara-hq-plugin-rel-b-0.1.0.tgz"]);
  }, 60_000);

  it("--plugins plans only the matching plugins", async () => {
    const { run, published } = await release(
      { plugins: [entry("d", packed.get("d") as string)] },
      { plugins: "plugins/d" },
    );
    expect((await run).published).toEqual([`${pkgName("d")}@0.1.0`]);
    expect(published).toEqual(["capybara-hq-plugin-rel-d-0.1.0.tgz"]);
  }, 60_000);
});
