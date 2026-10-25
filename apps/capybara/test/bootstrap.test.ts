import { createHash } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb, kernelDb } from "@capybara-hq/kernel";
import {
  startTestPostgres,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skillPlugin } from "../../../packages/kernel/test/catalog/packages.js";
import { DEFAULT_BOOTSTRAP_DIR, startBootstrapDir } from "../src/commands/bootstrap.js";
import { cleanEnv, packBootstrapDir, REPO_ROOT, runCli } from "./support/cli.js";

let pg: TestContainer;
let dir: string;

beforeAll(async () => {
  [pg, dir] = await Promise.all([startTestPostgres(), packBootstrapDir()]);
}, 180_000);
afterAll(async () => {
  await Promise.all([pg?.stop(), dir ? rm(dir, { recursive: true, force: true }) : 0]);
});

const env = (): NodeJS.ProcessEnv => ({
  ...cleanEnv(),
  CAPYBARA_DB__URL: pg.url,
  CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
  CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
});

async function query<T>(f: (db: ReturnType<typeof kernelDb>) => Promise<T>): Promise<T> {
  const raw = createDb(pg.url, 1);
  try {
    return await f(kernelDb(raw));
  } finally {
    await raw.destroy();
  }
}

const state = () =>
  query(async (db) => ({
    installs: await db
      .selectFrom("extension_installs")
      .select(["name", "version", "source", "required", "desired_state", "updated_at"])
      .orderBy("name")
      .execute(),
    snapshots: await db
      .selectFrom("extension_permission_snapshots")
      .select(["plugin", "source"])
      .orderBy("plugin")
      .execute(),
    runs: await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute(),
    completed: await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "bootstrap.completed")
      .execute(),
  }));

// The cases build on each other's database state, in order
describe("capybara bootstrap (the real bootstrap.json, packed like the image)", () => {
  it("a tampered package: exits 1 naming the plugin and writes nothing", async () => {
    const bad = `${dir}-tampered`;
    await cp(dir, bad, { recursive: true });
    try {
      const file = join(bad, "object-store-s3-0.1.0.tgz");
      const bytes = await readFile(file);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
      await writeFile(file, bytes);
      const r = await runCli(["bootstrap", "--dir", bad], env());
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/object-store-s3 0\.1\.0: .* does not match its pinned sha512/);
      const s = await state();
      expect(s.installs).toEqual([]);
      expect(s.runs).toEqual([]);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  }, 90_000);

  it("a missing directory: exits 1, says which file is missing and writes nothing", async () => {
    const r = await runCli(["bootstrap", "--dir", `${dir}-missing`], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /openai-compatible 0\.1\.0: .*openai-compatible-0\.1\.0\.tgz is missing/,
    );
    const s = await state();
    expect(s.installs).toEqual([]);
    expect(s.runs).toEqual([]);
  }, 90_000);

  it("installs, approves and enables every pinned plugin, required, and prints what it did", async () => {
    const r = await runCli(["bootstrap", "--dir", dir], env());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("openai-compatible 0.1.0: installed\n");
    expect(r.stdout).toContain("object-store-s3 0.1.0: installed\n");
    expect(r.stdout).toMatch(/Bootstrap done \(manifest sha256 [0-9a-f]{12}\)/);
    const s = await state();
    expect(s.installs).toEqual([
      expect.objectContaining({
        name: "object-store-s3",
        version: "0.1.0",
        source: "bootstrap",
        required: true,
        desired_state: "enabled",
      }),
      expect.objectContaining({
        name: "openai-compatible",
        version: "0.1.0",
        source: "bootstrap",
        required: true,
        desired_state: "enabled",
      }),
    ]);
    expect(s.snapshots).toEqual([
      { plugin: "object-store-s3", source: "bootstrap" },
      { plugin: "openai-compatible", source: "bootstrap" },
    ]);
    expect(s.runs).toHaveLength(1);
    expect(s.completed).toHaveLength(1);
  }, 120_000);

  it("a re-run for the same manifest does nothing", async () => {
    const before = await state();
    const r = await runCli(["bootstrap", "--dir", dir], env());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Bootstrap already done for this manifest/);
    expect(await state()).toEqual(before);
  }, 90_000);

  it("extensions list shows them with source bootstrap, required", async () => {
    const r = await runCli(["extensions", "list"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^object-store-s3\t0\.1\.0\tbootstrap\trequired\t/m);
    expect(r.stdout).toMatch(/^openai-compatible\t0\.1\.0\tbootstrap\trequired\t/m);
  }, 90_000);
});

/**
 * A fresh deployment whose manifest adds a declarative plugin: its catalog files need the object
 * store, which is the bootstrap plugin object-store-s3 the same run installs, so the CLI runs the
 * step a second time with a context that has the installed store.
 */
describe("capybara bootstrap with a declarative entry (second pass)", () => {
  let pg2: TestContainer;
  let s3: TestS3;
  let dir2: string;
  beforeAll(async () => {
    [pg2, s3] = await Promise.all([startTestPostgres(), startTestS3()]);
    dir2 = `${dir}-declarative`;
    await cp(dir, dir2, { recursive: true });
  }, 180_000);
  afterAll(async () => {
    await Promise.all([
      pg2?.stop(),
      s3?.stop(),
      dir2 ? rm(dir2, { recursive: true, force: true }) : 0,
    ]);
  });

  it("installs the extensions, then imports the declarative plugin through the installed store", async () => {
    const notes = await skillPlugin("notes", { version: "1.2.0" });
    await writeFile(join(dir2, "notes-1.2.0.tgz"), notes);
    const real = JSON.parse(
      await readFile(join(REPO_ROOT, "packages/kernel/bootstrap.json"), "utf8"),
    ) as { plugins: Record<string, unknown>[] };
    const manifest = join(dir2, "bootstrap.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          ...real.plugins,
          {
            name: "notes",
            source: "workspace",
            path: "plugins/notes",
            version: "1.2.0",
            integrity: `sha512-${createHash("sha512").update(notes).digest("base64")}`,
            required: false,
          },
        ],
      }),
    );
    const r = await runCli(["bootstrap", "--dir", dir2, "--manifest", manifest], {
      ...env(),
      CAPYBARA_DB__URL: pg2.url,
      CAPYBARA_EXTENSION_CONFIG: JSON.stringify({
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("object-store-s3 0.1.0: installed\n");
    expect(r.stdout).toContain("openai-compatible 0.1.0: installed\n");
    expect(r.stdout).toContain("notes 1.2.0: imported into the catalog\n");
    const raw = createDb(pg2.url, 1);
    try {
      const db = kernelDb(raw);
      expect(
        await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute(),
      ).toHaveLength(1);
      expect(
        await db.selectFrom("catalog_items").select("name").where("name", "=", "notes").execute(),
      ).toHaveLength(1);
    } finally {
      await raw.destroy();
    }
  }, 180_000);
});

describe("startBootstrapDir", () => {
  it("the given directory, else the image's default when it exists, else none", () => {
    expect(startBootstrapDir("/b", () => false)).toBe("/b");
    expect(startBootstrapDir(undefined, (p) => p === DEFAULT_BOOTSTRAP_DIR)).toBe("/app/bootstrap");
    expect(startBootstrapDir(undefined, () => false)).toBeUndefined();
  });
});
