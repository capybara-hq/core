import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeGitServer,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CatalogCli, openCatalogCli } from "../../src/catalog/cli.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { mergeBootstrapManifests } from "../../src/extensions/bootstrap-extra.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { packPackageTgz, unpackPackageTgz } from "../../src/packages/tgz.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { runConfig } from "../helpers/runs.js";

// `capybara bootstrap` runs in compose `init`, before any kernel start: no marketplace rows exist
// yet, and the git entries of the extra manifest are read all the same (spec
// 2026-11-20-bootstrap-extra-manifest §4). This drives the CLI's context the command opens.

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let cli: CatalogCli;

const TOKEN = "bootstrap-cli-s3cret";
const USER = "oauth2";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 2);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer({ requireBasic: { username: USER, password: TOKEN } });
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-bootstrap-git-cli-"));
  const config = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      extensionHost: { dir: pluginsDir },
      extensions: [],
      marketplaces: { allowInsecureLoopback: true, tokens: { dist: TOKEN } },
    },
  );
  cli = await openCatalogCli(config, createLogger("error", { write: () => {} }));
});

afterAll(async () => {
  await cli?.close();
  await destroyDb?.();
  await srv?.stop();
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("capybara bootstrap with git entries", () => {
  it("capybara bootstrap installs git entries before any kernel start", async () => {
    const unpacked = await unpackPackageTgz(
      await pluginTgz({ manifest: { name: "cli-ext" }, extension: {} }),
      { maxBytes: 10 * 1024 * 1024 },
    );
    const files = Object.fromEntries(
      unpacked.map((f) => [`plugins/cli-ext/${f.path}`, f.data.toString("utf8")]),
    );
    const commit = await srv.commit("dist", files);
    const pack = await packPackageTgz(new Map(unpacked.map((f) => [f.path, f.data])));
    const integrity = `sha512-${createHash("sha512").update(pack).digest("base64")}`;
    expect(await db.selectFrom("marketplaces").select("id").execute()).toEqual([]);
    const manifest = mergeBootstrapManifests(
      { schemaVersion: 1, plugins: [] },
      {
        schemaVersion: 1,
        marketplaces: [{ name: "dist", url: srv.url("dist"), username: USER }],
        plugins: [
          {
            name: "cli-ext",
            source: "git",
            marketplace: "dist",
            commit,
            path: "./plugins/cli-ext",
            version: "1.0.0",
            integrity,
          },
        ],
      },
    );
    const r = await cli.bootstrap.run({ manifest, imports: cli.imports });
    expect(r.results).toEqual([{ name: "cli-ext", action: "installed", version: "1.0.0" }]);
    expect(
      await db.selectFrom("extension_installs").select(["name", "source", "sha256"]).execute(),
    ).toEqual([
      {
        name: "cli-ext",
        source: "bootstrap",
        sha256: createHash("sha256").update(pack).digest("hex"),
      },
    ]);
    const v = await db
      .selectFrom("catalog_item_versions as v")
      .innerJoin("catalog_items as i", "i.id", "v.item_id")
      .select(["i.marketplace_id", "v.integrity", "v.source_ref", "v.source_detail"])
      .executeTakeFirstOrThrow();
    // no managed row yet: the git location is recorded, the marketplace is named by a later import
    const u = new URL(srv.url("dist"));
    expect(v).toEqual({
      marketplace_id: null,
      integrity,
      source_ref: `config:dist:${u.origin}${u.pathname}@${commit}:plugins/cli-ext`,
      source_detail: expect.objectContaining({
        host: u.host,
        repo: u.pathname.slice(1),
        path: "plugins/cli-ext",
        commit,
      }),
    });
    expect(await db.selectFrom("marketplaces").select("id").execute()).toEqual([]);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorized)).toBe(true);
  });
});
