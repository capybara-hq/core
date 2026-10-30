import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb, kernelDb } from "@capybara-hq/kernel";
import {
  type FakeNpmRegistry,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skillPlugin } from "../../../packages/kernel/test/catalog/packages.js";
import { bootstrapDirOf } from "../src/commands/bootstrap.js";
import {
  type BootstrapEntry,
  cleanEnv,
  type FakeBootstrapDir,
  fakeManifest,
  packFakeBootstrapDir,
  REPO_ROOT,
  runCli,
} from "./support/cli.js";

let pg: TestContainer;
/** The bootstrap step runs under the Redis lock `lock:bootstrap` (shared with starting kernels). */
let rd: TestContainer;
let boot: FakeBootstrapDir;
let dir: string;
/** A registry URL nothing listens on: any download fails (core tests never reach npm). */
let downRegistry: string;

/**
 * The fakes stand in for the real pins (core tests never download published plugins): `A` is a
 * model provider like openai-compatible, `B` an S3 object store like object-store-s3. The real manifest is exercised by the web e2e
 * setup and the docker smoke tests.
 */
const A = "fake-bootstrap-a";
const B = "fake-object-store";
let A_V: string;
let B_V: string;
const re = (v: string) => v.replaceAll(".", "\\.");

beforeAll(async () => {
  [pg, rd, boot] = await Promise.all([
    startTestPostgres(),
    startTestRedis(),
    packFakeBootstrapDir(),
  ]);
  dir = boot.dir;
  const down = await startFakeNpmRegistry({ packages: [] });
  await down.stop();
  downRegistry = down.url;
  const version = (name: string) => boot.entries.find((e) => e.name === name)?.version as string;
  [A_V, B_V] = [version(A), version(B)];
}, 180_000);
afterAll(async () => {
  await Promise.all([pg?.stop(), rd?.stop(), dir ? rm(dir, { recursive: true, force: true }) : 0]);
});

const env = (): NodeJS.ProcessEnv => ({
  ...cleanEnv(),
  CAPYBARA_DB__URL: pg.url,
  CAPYBARA_REDIS__URL: rd.url,
  CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  CAPYBARA_PACKAGES__NPM_REGISTRY: downRegistry,
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
/** `capybara bootstrap` on the fake bootstrap directory (`--manifest` in `at`, default `dir`). */
const bootstrap = (at: string, e: NodeJS.ProcessEnv = env()) =>
  runCli(["bootstrap", "--dir", at, "--manifest", join(at, "bootstrap.json")], e);

describe("capybara bootstrap (a manifest of npm pins, an offline directory)", () => {
  it("a tampered package is not that plugin's: downloaded instead, which fails; exits 1 naming the plugin and writes nothing", async () => {
    const bad = `${dir}-tampered`;
    await cp(dir, bad, { recursive: true });
    try {
      const file = join(bad, `${B}-${B_V}.tgz`);
      const bytes = await readFile(file);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
      await writeFile(file, bytes);
      const r = await bootstrap(bad);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`${B} ${re(B_V)}: cannot download`));
      expect(r.stderr).toContain(bad);
      const s = await state();
      expect(s.installs).toEqual([]);
      expect(s.runs).toEqual([]);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  }, 90_000);

  it("a missing directory and no registry: exits 1, says how to provide the package and writes nothing", async () => {
    const r = await runCli(
      ["bootstrap", "--dir", `${dir}-missing`, "--manifest", boot.manifest],
      env(),
    );
    expect(r.code).toBe(1);
    const npmA = boot.entries.find((e) => e.name === A)?.npm as string;
    expect(r.stderr).toMatch(new RegExp(`${A} ${re(A_V)}: cannot download`));
    expect(r.stderr).toContain(`npm pack ${npmA}@${A_V}`);
    expect(r.stderr).toContain(`${dir}-missing`);
    const s = await state();
    expect(s.installs).toEqual([]);
    expect(s.runs).toEqual([]);
  }, 90_000);

  it("without --manifest: reads the kernel's bootstrap.json, whose packages the fakes' directory lacks", async () => {
    const real = JSON.parse(
      await readFile(join(REPO_ROOT, "packages/kernel/bootstrap.json"), "utf8"),
    ) as { plugins: { name: string; npm: string; version: string }[] };
    const first = real.plugins[0] as { name: string; npm: string; version: string };
    const r = await runCli(["bootstrap", "--dir", dir], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${first.name} ${first.version}: `);
    expect(r.stderr).toContain(`cannot download ${first.npm}@${first.version}`);
    const s = await state();
    expect(s.installs).toEqual([]);
    expect(s.runs).toEqual([]);
  }, 90_000);

  it("installs, approves and enables every pinned plugin from the directory (no registry), required, and prints what it did", async () => {
    const r = await bootstrap(dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${A} ${A_V}: installed\n`);
    expect(r.stdout).toContain(`${B} ${B_V}: installed\n`);
    expect(r.stdout).toMatch(/Bootstrap done \(manifest sha256 [0-9a-f]{12}\)/);
    const s = await state();
    expect(s.installs).toEqual([
      expect.objectContaining({
        name: A,
        version: A_V,
        source: "bootstrap",
        required: true,
        desired_state: "enabled",
      }),
      expect.objectContaining({
        name: B,
        version: B_V,
        source: "bootstrap",
        required: true,
        desired_state: "enabled",
      }),
    ]);
    expect(s.snapshots).toEqual([
      { plugin: A, source: "bootstrap" },
      { plugin: B, source: "bootstrap" },
    ]);
    expect(s.runs).toHaveLength(1);
    expect(s.completed).toHaveLength(1);
  }, 120_000);

  it("a re-run for the same manifest does nothing", async () => {
    const before = await state();
    const r = await bootstrap(dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Bootstrap already done for this manifest/);
    expect(await state()).toEqual(before);
  }, 90_000);

  it("extensions list shows them with source bootstrap, required", async () => {
    const r = await runCli(["extensions", "list"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^${A}\\t${re(A_V)}\\tbootstrap\\trequired\\t`, "m"));
    expect(r.stdout).toMatch(new RegExp(`^${B}\\t${re(B_V)}\\tbootstrap\\trequired\\t`, "m"));
  }, 90_000);
});

/**
 * A fresh deployment whose manifest adds a declarative plugin: its catalog files need the object
 * store, which is the bootstrap object store (fake-object-store) the same run installs, so the CLI
 * runs the step a second time with a context that has the installed store.
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
    const manifest = join(dir2, "bootstrap.json");
    await writeFile(
      manifest,
      JSON.stringify(
        fakeManifest([
          ...boot.entries,
          {
            name: "notes",
            source: "npm",
            npm: "@capybara-hq/plugin-notes",
            version: "1.2.0",
            integrity: `sha512-${createHash("sha512").update(notes).digest("base64")}`,
            required: false,
          } satisfies BootstrapEntry,
        ]),
      ),
    );
    const r = await runCli(["bootstrap", "--dir", dir2, "--manifest", manifest], {
      ...env(),
      CAPYBARA_DB__URL: pg2.url,
      CAPYBARA_EXTENSION_CONFIG: JSON.stringify({
        [B]: {
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
    expect(r.stdout).toContain(`${A} ${A_V}: installed\n`);
    expect(r.stdout).toContain(`${B} ${B_V}: installed\n`);
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

/**
 * Ruling 7: an optional entry that still fails after the second pass (here a declarative plugin
 * whose catalog files need an object store that has no config: fake-object-store without config) is a warning, not a failed init:
 * exit 0, the extensions are installed, and nothing is recorded as done so a later run retries.
 */
describe("capybara bootstrap when only an optional entry fails", () => {
  let pg3: TestContainer;
  let dir3: string;
  beforeAll(async () => {
    pg3 = await startTestPostgres();
    dir3 = `${dir}-optional`;
    await cp(dir, dir3, { recursive: true });
  }, 180_000);
  afterAll(async () => {
    await Promise.all([pg3?.stop(), dir3 ? rm(dir3, { recursive: true, force: true }) : 0]);
  });

  it("exits 0 with warnings and records nothing as done", async () => {
    const notes = await skillPlugin("notes", { version: "1.2.0" });
    await writeFile(join(dir3, "notes-1.2.0.tgz"), notes);
    const manifest = join(dir3, "bootstrap.json");
    await writeFile(
      manifest,
      JSON.stringify(
        fakeManifest([
          ...boot.entries,
          {
            name: "notes",
            source: "npm",
            npm: "@capybara-hq/plugin-notes",
            version: "1.2.0",
            integrity: `sha512-${createHash("sha512").update(notes).digest("base64")}`,
            required: false,
          } satisfies BootstrapEntry,
        ]),
      ),
    );
    const r = await runCli(["bootstrap", "--dir", dir3, "--manifest", manifest], {
      ...env(),
      CAPYBARA_DB__URL: pg3.url,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${A} ${A_V}: installed\n`);
    expect(r.stdout).toContain(`${B} ${B_V}: installed\n`);
    expect(r.stdout).not.toContain("notes 1.2.0");
    expect(r.stdout).not.toContain("Bootstrap done");
    expect(r.stderr).toContain("capybara: bootstrap: warning: notes: ");
    expect(r.stderr).toContain("optional plugins could not be installed");
    const raw = createDb(pg3.url, 1);
    try {
      const db = kernelDb(raw);
      expect(await db.selectFrom("bootstrap_runs").select("manifest_sha256").execute()).toEqual([]);
      expect(
        (await db.selectFrom("extension_installs").select("name").orderBy("name").execute()).map(
          (x) => x.name,
        ),
      ).toEqual([A, B]);
    } finally {
      await raw.destroy();
    }
  }, 180_000);
});

/**
 * A fresh deployment without offline packages: the step downloads every pin from the registry
 * (`packages.npmRegistry`), the offline directory coming from `CAPYBARA_BOOTSTRAP__DIR`.
 */
describe("capybara bootstrap from npm", () => {
  let pg4: TestContainer;
  let reg: FakeNpmRegistry;
  let empty: string;
  beforeAll(async () => {
    pg4 = await startTestPostgres();
    empty = await mkdtemp(join(tmpdir(), "capybara-bootstrap-empty-"));
    reg = await startFakeNpmRegistry({
      packages: await Promise.all(
        boot.entries.map(async (e) => ({
          name: e.npm,
          version: e.version,
          tgz: new Uint8Array(await readFile(join(dir, `${e.name}-${e.version}.tgz`))),
        })),
      ),
    });
  }, 180_000);
  afterAll(async () => {
    await Promise.all([
      pg4?.stop(),
      reg?.stop(),
      empty ? rm(empty, { recursive: true, force: true }) : 0,
    ]);
  });

  it("an empty directory (from the config key): downloads and installs every pin", async () => {
    const r = await runCli(["bootstrap", "--manifest", boot.manifest], {
      ...env(),
      CAPYBARA_DB__URL: pg4.url,
      CAPYBARA_PACKAGES__NPM_REGISTRY: reg.url,
      CAPYBARA_BOOTSTRAP__DIR: empty,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${A} ${A_V}: installed\n`);
    expect(r.stdout).toContain(`${B} ${B_V}: installed\n`);
    expect(reg.requests.filter((p) => p.includes("/-/"))).toHaveLength(2);
  }, 120_000);
});

describe("bootstrapDirOf", () => {
  it("--dir, else config bootstrap.dir, resolved against the working directory", () => {
    const config = { bootstrap: { dir: "bootstrap" } };
    expect(bootstrapDirOf(config, undefined, "/app")).toBe("/app/bootstrap");
    expect(bootstrapDirOf(config, "/b", "/app")).toBe("/b");
    expect(bootstrapDirOf({ bootstrap: { dir: "x/y" } }, undefined, "/srv")).toBe("/srv/x/y");
    expect(bootstrapDirOf(config)).toBe(resolve(process.cwd(), "bootstrap"));
  });
});
