import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeNpmRegistry, startFakeNpmRegistry } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packBootstrap, packPlugin } from "../src/pack/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
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
});

describe("packBootstrap: npm entries", () => {
  let tgz: Uint8Array;
  let reg: FakeNpmRegistry;
  const PKG = "@capybara-hq/plugin-declarative";
  beforeAll(async () => {
    const r = await packPlugin(join(fakeRoot, "plugins/declarative"), join(work, "npm-ref"));
    tgz = new Uint8Array(await readFile(r.file));
    const tampered = Uint8Array.from(tgz);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    reg = await startFakeNpmRegistry({
      packages: [
        { name: PKG, version: pinned.version, tgz },
        // same version on another package name, bytes changed after the pin was taken
        { name: "@capybara-hq/plugin-tampered", version: pinned.version, tgz: tampered },
      ],
    });
  });
  afterAll(async () => {
    await reg?.stop();
  });

  /** A manifest with one npm entry (the marketplace commit is required with npm entries). */
  async function npmManifest(over: Record<string, unknown> = {}): Promise<string> {
    const file = join(work, `npm-${Math.random().toString(36).slice(2)}.json`);
    const entry = { ...pinned, source: "npm", npm: PKG, required: true, ...over };
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        marketplace: { url: "https://github.com/capybara-hq/plugins.git", commit: "a".repeat(40) },
        plugins: [entry],
      }),
    );
    return file;
  }

  it("downloads the pinned version from the registry and writes it once its sha512 matches", async () => {
    const out = join(work, "npm-ok");
    const r = await packBootstrap(await npmManifest(), fakeRoot, out, { registry: reg.url });
    const file = join(out, `${pinned.name}-${pinned.version}.tgz`);
    expect(r).toEqual([{ ...pinned, file }]);
    expect(new Uint8Array(await readFile(file))).toEqual(tgz);
    expect(reg.requests).toContain("/@capybara-hq%2fplugin-declarative");
  });

  it("refuses a tampered tarball, naming the plugin, and writes nothing for it", async () => {
    const out = join(work, "npm-tampered");
    await expect(
      packBootstrap(await npmManifest({ npm: "@capybara-hq/plugin-tampered" }), fakeRoot, out, {
        registry: reg.url,
      }),
    ).rejects.toThrow(
      new RegExp(
        `^${pinned.name}: @capybara-hq/plugin-tampered@${pinned.version} from .* has sha512 .*, not the pinned`,
      ),
    );
    expect(await readdir(out)).toEqual([]);
  });

  it("refuses an unpublished package or version", async () => {
    const out = join(work, "npm-missing");
    await expect(
      packBootstrap(await npmManifest({ npm: "@capybara-hq/plugin-nope" }), fakeRoot, out, {
        registry: reg.url,
      }),
    ).rejects.toThrow(
      new RegExp(`^${pinned.name}: @capybara-hq/plugin-nope is not published on http`),
    );
    await expect(
      packBootstrap(await npmManifest({ version: "9.9.9" }), fakeRoot, out, { registry: reg.url }),
    ).rejects.toThrow(/@capybara-hq\/plugin-declarative@9\.9\.9 is not published/);
    expect(await readdir(out)).toEqual([]);
  });
});
