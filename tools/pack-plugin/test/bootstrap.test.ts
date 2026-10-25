import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packBootstrap, packPlugin } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = join(here, "fixtures/declarative");

let work: string;
/** A repository root whose plugins/declarative is the fixture (entry paths are plugins/<dir>). */
let fakeRoot: string;
let pinned: { name: string; version: string; integrity: string };
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "pack-bootstrap-test-"));
  fakeRoot = join(work, "repo");
  await mkdir(join(fakeRoot, "plugins"), { recursive: true });
  await symlink(fixture, join(fakeRoot, "plugins/declarative"), "dir");
  const r = await packPlugin(join(fakeRoot, "plugins/declarative"), join(work, "ref"));
  pinned = {
    name: r.manifest.name,
    version: r.manifest.version,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(r.file))
      .digest("base64")}`,
  };
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A manifest with one workspace entry for the declarative fixture (path relative to {@link fakeRoot}). */
async function manifest(over: Record<string, unknown> = {}): Promise<string> {
  const file = join(work, `bootstrap-${Math.random().toString(36).slice(2)}.json`);
  const entry = {
    ...pinned,
    source: "workspace",
    path: "plugins/declarative",
    required: false,
    ...over,
  };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, plugins: [entry] }));
  return file;
}

describe("packBootstrap", () => {
  it("writes every workspace entry as <name>-<version>.tgz matching its pinned sha512", async () => {
    const out = join(work, "ok");
    const r = await packBootstrap(await manifest(), fakeRoot, out);
    expect(r).toEqual([{ ...pinned, file: join(out, `${pinned.name}-${pinned.version}.tgz`) }]);
    expect(await readdir(out)).toEqual([`${pinned.name}-${pinned.version}.tgz`]);
  });

  it("refuses a stale pin, naming the plugin, and writes nothing for it", async () => {
    const out = join(work, "stale");
    const bad = `sha512-${Buffer.alloc(64).toString("base64")}`;
    await expect(packBootstrap(await manifest({ integrity: bad }), fakeRoot, out)).rejects.toThrow(
      new RegExp(`^${pinned.name}: integrity is ${bad.replace(/[+/]/g, "\\$&")} but`),
    );
    await expect(
      packBootstrap(await manifest({ version: "9.9.9" }), fakeRoot, out),
    ).rejects.toThrow(/version is 9\.9\.9 but/);
    expect(await readdir(out)).toEqual([]);
  });

  it("refuses npm entries until they can be downloaded (phase A3)", async () => {
    const file = join(work, "npm.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        marketplace: { url: "https://github.com/capybara-hq/plugins.git", commit: "a".repeat(40) },
        plugins: [
          {
            name: "x",
            source: "npm",
            npm: "@capybara-hq/plugin-x",
            version: "1.0.0",
            integrity: pinned.integrity,
            required: true,
          },
        ],
      }),
    );
    await expect(packBootstrap(file, fakeRoot, join(work, "npm"))).rejects.toThrow(
      /not supported yet/,
    );
  });

  it("the repository's bootstrap.json packs as pinned", async () => {
    const out = join(work, "real");
    const r = await packBootstrap(join(root, "packages/kernel/bootstrap.json"), root, out);
    expect(r.map((p) => p.name).sort()).toEqual(["object-store-s3", "openai-compatible"]);
  }, 120_000);
});
