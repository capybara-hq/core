import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeGitServer,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import semver from "semver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gitFallbackVersion } from "../../src/catalog/catalog.service.js";
import { marketplaceForm } from "../../src/catalog/marketplaces.service.js";
import {
  allowedHostProblem,
  type KernelConfig,
  KernelConfigSchema,
} from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { unpackPackageTgz } from "../../src/packages/tgz.js";
import { truncateTables } from "../helpers/db.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
/** Hosts the marketplace repos. */
let srv: FakeGitServer;
/** Another origin (same host, other port): the repos that git entries point to. */
let other: FakeGitServer;
let pluginsDir: string;
let k: Kernel;
let admin: Req;

const TOKEN = "s3cret-git-token";
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;

/** The files of a plugin tgz built by `pluginTgz`, as a git tree (paths relative to the root). */
async function pluginFiles(
  o: Parameters<typeof pluginTgz>[0],
  drop: string[] = [],
): Promise<Record<string, string>> {
  const files = await unpackPackageTgz(await pluginTgz(o), { maxBytes: 10 * 1024 * 1024 });
  return Object.fromEntries(
    files.filter((f) => !drop.includes(f.path)).map((f) => [f.path, f.data.toString("utf8")]),
  );
}

const under = (dir: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([p, d]) => [`${dir}/${p}`, d]));

const skill = (name: string) => ({ [`skills/${name}/SKILL.md`]: SKILL_MD(name) });

/** Commits in `other` (set in beforeAll). */
let remoteA1: string;
let remoteB: string;

async function marketplaceRepo(extraPlugins: unknown[] = []): Promise<string> {
  const manifest = {
    schemaVersion: 1,
    name: "Acme git marketplace",
    owner: { name: "Acme Corp" },
    plugins: [
      {
        name: "git-skills",
        summary: { en: "skills only" },
        source: { path: "./plugins/git-skills" },
      },
      { name: "git-decl", summary: { en: "declarative" }, source: { path: "./plugins/git-decl" } },
      { name: "git-ext", summary: { en: "extension" }, source: { path: "./plugins/git-ext" } },
      { name: "no-build", summary: { en: "no build" }, source: { path: "./plugins/no-build" } },
      { name: "no-pkg", summary: { en: "no package.json" }, source: { path: "./plugins/no-pkg" } },
      {
        name: "remote-a",
        summary: { en: "pinned" },
        source: { git: { url: other.url("remote-a"), commit: remoteA1 } },
      },
      {
        name: "remote-b",
        summary: { en: "follows main" },
        source: { git: { url: other.url("remote-b"), ref: "main", path: "." } },
      },
      {
        name: "outside",
        summary: { en: "another host" },
        source: { git: { url: "https://git.example.com/acme/outside.git" } },
      },
      ...extraPlugins,
    ],
  };
  return srv.commit("mkt", {
    ".capybara-plugin/marketplace.json": JSON.stringify(manifest),
    "README.md": "# marketplace\n",
    ...under("plugins/git-skills", skill("git-skills")),
    ...under(
      "plugins/git-decl",
      await pluginFiles(
        { manifest: { name: "git-decl", publisher: "Decl Inc" }, files: skill("decl") },
        ["package.json"],
      ),
    ),
    ...under(
      "plugins/git-ext",
      await pluginFiles({
        manifest: { name: "git-ext" },
        packageName: "@acme/plugin-git-ext",
        extension: {},
      }),
    ),
    ...under(
      "plugins/no-build",
      await pluginFiles({ manifest: { name: "no-build" }, extension: {} }, ["dist/index.mjs"]),
    ),
    ...under(
      "plugins/no-pkg",
      await pluginFiles({ manifest: { name: "no-pkg" }, extension: {} }, ["package.json"]),
    ),
  });
}

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  [srv, other] = await Promise.all([startFakeGitServer(), startFakeGitServer()]);
  remoteA1 = await other.commit(
    "remote-a",
    await pluginFiles({ manifest: { name: "remote-a", version: "1.0.0" }, files: skill("ra") }),
  );
  // the pinned commit is no longer the tip
  await other.commit(
    "remote-a",
    await pluginFiles({ manifest: { name: "remote-a", version: "2.0.0" }, files: skill("ra") }),
  );
  remoteB = await other.commit(
    "remote-b",
    await pluginFiles({ manifest: { name: "remote-b", version: "1.2.0" }, files: skill("rb") }),
  );
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-git-marketplaces-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api"],
      extensionHost: { dir: pluginsDir },
      marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
      extensions: [S3_PLUGIN],
      extensionConfig: {
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    },
  );
  k = await createKernel(config, { env: {} });
  await k.start();
  await new AccountsService(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
}, 240_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([srv?.stop(), other?.stop()]);
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.extension_installs, capybara.extension_blobs, capybara.extension_packages, capybara.extension_name_owners, capybara.extension_permission_snapshots, capybara.audit_events",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
  await db.deleteFrom("secrets").where("key", "like", "catalog-token:%").execute();
  srv.requests.length = 0;
  other.requests.length = 0;
});

async function addGit(body: Record<string, unknown>): Promise<string> {
  const res = await admin({
    method: "POST",
    url: "/api/v1/admin/marketplaces",
    payload: { name: "Acme git", ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
const refresh = (id: string) =>
  admin({ method: "POST", url: `/api/v1/admin/marketplaces/${id}/refresh` });
const entries = async (id: string) => {
  const res = await admin({
    method: "GET",
    url: `/api/v1/admin/marketplaces/entries?sourceId=${id}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return new Map(res.json().items.map((e: { name: string }) => [e.name, e] as const)) as Map<
    string,
    Record<string, unknown>
  >;
};
const importEntry = (id: string, name: string) =>
  admin({
    method: "POST",
    url: `/api/v1/admin/marketplaces/${id}/entries/${name}/import`,
    payload: {},
  });
const confirm = async (prepared: { stagingId: string; review: { reviewHash: string } }) => {
  const c = await admin({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${prepared.stagingId}/confirm`,
    payload: { reviewHash: prepared.review.reviewHash, deployExtension: false },
  });
  expect(c.statusCode, c.body).toBe(201);
  return c.json();
};
const version = (name: string) =>
  db
    .selectFrom("catalog_item_versions as v")
    .innerJoin("catalog_items as i", "i.id", "v.item_id")
    .select([
      "v.version",
      "v.source",
      "v.source_ref",
      "v.source_detail",
      "i.package_name",
      "i.marketplace_id",
      "i.publisher",
    ])
    .where("i.name", "=", name)
    .executeTakeFirstOrThrow();

async function nothingImported(): Promise<void> {
  expect(await db.selectFrom("catalog_items").select("id").execute()).toEqual([]);
  expect(await db.selectFrom("extension_packages").select("sha256").execute()).toEqual([]);
  expect(await db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
}

describe("marketplaceForm", () => {
  it("tells the http form from the git form and expands owner/repo", () => {
    expect(marketplaceForm("https://m.example.com/marketplace.json")).toEqual({
      form: "http",
      url: "https://m.example.com/marketplace.json",
    });
    expect(marketplaceForm("https://m.example.com/v1/index")).toEqual({
      form: "http",
      url: "https://m.example.com/v1/index",
    });
    expect(marketplaceForm("acme/tools")).toEqual({
      form: "git",
      url: "https://github.com/acme/tools.git",
    });
    expect(marketplaceForm("https://gitlab.example.com/a/b.git")).toEqual({
      form: "git",
      url: "https://gitlab.example.com/a/b.git",
    });
    expect(marketplaceForm("https://gitlab.example.com/a/b", "git")).toEqual({
      form: "git",
      url: "https://gitlab.example.com/a/b",
    });
    expect(marketplaceForm("https://gitlab.example.com/a/b.git", "http")).toEqual({
      form: "http",
      url: "https://gitlab.example.com/a/b.git",
    });
  });
});

describe("pure rules", () => {
  it("the fallback version is valid semver even for an all-digit sha with a leading zero", () => {
    const sha = `012345678901${"a".repeat(28)}`;
    expect(gitFallbackVersion(sha)).toBe("0.0.0-git.g012345678901");
    expect(semver.valid(gitFallbackVersion(sha))).toBe("0.0.0-git.g012345678901");
  });

  it("allowedHosts takes hostnames and IPs, never a port, brackets or a scheme", () => {
    expect(allowedHostProblem("github.com")).toBeUndefined();
    expect(allowedHostProblem("10.0.0.1")).toBeUndefined();
    expect(allowedHostProblem("::1")).toBeUndefined();
    expect(allowedHostProblem("github.com:443")).toMatch(/without a scheme, port or path/);
    expect(allowedHostProblem("[::1]")).toMatch(/without brackets/);
    expect(allowedHostProblem("https://github.com")).toMatch(/without a scheme/);
    expect(allowedHostProblem("bad_host")).toMatch(/not a hostname/);
    const r = KernelConfigSchema.safeParse({
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32).toString("base64"),
      marketplaces: { allowedHosts: ["gitlab.example.com:8443"] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("without a scheme, port or path");
  });
});

describe("git marketplaces", () => {
  it("refresh reads .capybara-plugin/marketplace.json at the branch head; an unchanged commit is skipped", async () => {
    const head = await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt") });
    const view = (await admin({ method: "GET", url: "/api/v1/admin/marketplaces" }))
      .json()
      .items.find((m: { id: string }) => m.id === id);
    expect(view).toMatchObject({ form: "git", ref: null, lastCommit: null, mirrors: [] });

    const r = await refresh(id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      form: "git",
      lastStatus: "ok",
      lastCommit: head,
      entryCount: 8,
    });
    const e = await entries(id);
    expect([...e.keys()].sort()).toEqual([
      "git-decl",
      "git-ext",
      "git-skills",
      "no-build",
      "no-pkg",
      "outside",
      "remote-a",
      "remote-b",
    ]);
    expect(e.get("git-skills")).toMatchObject({
      importable: true,
      source: { path: "./plugins/git-skills" },
    });
    expect(e.get("remote-a")).toMatchObject({ importable: true });
    expect(e.get("outside")).toMatchObject({ importable: false, reason: "host_not_allowed" });

    // no new commit: only the refs are listed, the entries are not rewritten
    await db
      .updateTable("marketplace_entries")
      .set({ npm: "marker" })
      .where("source_id", "=", id)
      .where("name", "=", "git-skills")
      .execute();
    srv.requests.length = 0;
    const again = await refresh(id);
    expect(again.statusCode, again.body).toBe(200);
    expect(
      srv.requests.some((q) => q.path.includes("git-upload-pack") && q.method === "POST"),
    ).toBe(false);
    const marker = await db
      .selectFrom("marketplace_entries")
      .select("npm")
      .where("source_id", "=", id)
      .where("name", "=", "git-skills")
      .executeTakeFirstOrThrow();
    expect(marker.npm).toBe("marker");

    // a new commit replaces the entries
    const next = await marketplaceRepo([
      { name: "late", summary: { en: "late" }, source: { path: "./plugins/git-skills" } },
    ]);
    const third = await refresh(id);
    expect(third.json()).toMatchObject({ lastCommit: next, entryCount: 9 });
    expect((await entries(id)).has("late")).toBe(true);
  });

  it("a ref follows that branch; a missing repo fails the refresh with marketplace.git_failed", async () => {
    await srv.commit("branchy", { ".capybara-plugin/plugin.json": "{}" });
    const dev = await srv.commit("branchy", skill("dev-only"), { branch: "dev" });
    const id = await addGit({ url: srv.url("branchy"), ref: "dev" });
    const r = await refresh(id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ref: "dev", lastCommit: dev, entryCount: 1 });
    expect([...(await entries(id)).keys()]).toEqual(["branchy"]);

    const missing = await addGit({ url: srv.url("does-not-exist") });
    const f = await refresh(missing);
    expect(f.statusCode, f.body).toBe(502);
    expect(f.json().error.code).toBe("marketplace.git_failed");
    expect((await k.marketplaces.get(missing)).lastStatus).toBe("error");
  });

  it("a single-plugin repo is a marketplace with one entry (plugin.json name, else the repo name)", async () => {
    await srv.commit(
      "solo-repo",
      await pluginFiles({
        manifest: { name: "solo", version: "3.1.0", description: "Solo plugin" },
        files: skill("solo"),
      }),
    );
    const a = await addGit({ url: srv.url("solo-repo") });
    expect((await refresh(a)).json()).toMatchObject({ lastStatus: "ok", entryCount: 1 });
    expect((await entries(a)).get("solo")).toMatchObject({
      version: "3.1.0",
      summary: { en: "Solo plugin" },
      importable: true,
    });

    await srv.commit("lone-skills", skill("lone"));
    const b = await addGit({ url: srv.url("lone-skills") });
    expect((await refresh(b)).json()).toMatchObject({ lastStatus: "ok", entryCount: 1 });
    const lone = (await entries(b)).get("lone-skills");
    expect(lone).toMatchObject({ version: null, importable: true });
    const res = await importEntry(b, "lone-skills");
    expect(res.statusCode, res.body).toBe(200);
    // no marketplace owner: the publisher is the repo's host (the fake server has no owner segment)
    expect(res.json().review.publisher).toBe(new URL(srv.url("x")).host);
  });

  it("importing path entries reads the marketplace commit: source git with source_detail; skills-only and plugin.json without package.json", async () => {
    const head = await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt") });
    expect((await refresh(id)).statusCode).toBe(200);

    const res = await importEntry(id, "git-skills");
    expect(res.statusCode, res.body).toBe(200);
    const review = res.json().review;
    expect(review).toMatchObject({
      name: "git-skills",
      version: `0.0.0-git.g${head.slice(0, 12)}`,
      packageName: null,
      publisher: "Acme Corp",
      skills: [{ name: "git-skills" }],
      source: {
        kind: "git",
        marketplaceId: id,
        detail: {
          host: new URL(srv.url("x")).host,
          repo: "mkt.git",
          path: "plugins/git-skills",
          commit: head,
          followsBranch: true,
        },
      },
    });
    expect(JSON.stringify(review)).not.toContain("undefined");
    await confirm(res.json());
    const v = await version("git-skills");
    expect(v).toMatchObject({
      source: "git",
      package_name: null,
      marketplace_id: id,
      publisher: "Acme Corp",
      source_detail: {
        repo: "mkt.git",
        path: "plugins/git-skills",
        commit: head,
        followsBranch: true,
      },
    });
    expect(v.source_ref).toBe(
      `${id}:${new URL(srv.url("mkt")).origin}/mkt.git@${head}:plugins/git-skills`,
    );

    const decl = await importEntry(id, "git-decl");
    expect(decl.statusCode, decl.body).toBe(200);
    expect(decl.json().review).toMatchObject({
      name: "git-decl",
      version: "1.0.0",
      packageName: null,
      publisher: "Decl Inc",
    });
    await confirm(decl.json());
    const detail = await admin({
      method: "GET",
      url: `/api/v1/admin/catalog/items/${(await db.selectFrom("catalog_items").select("id").where("name", "=", "git-decl").executeTakeFirstOrThrow()).id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().item.packageName).toBeNull();
    expect(detail.json().versions[0]).toMatchObject({
      source: "git",
      sourceDetail: { path: "plugins/git-decl", commit: head, followsBranch: true },
    });
  });

  it("an extension plugin from git is packed and reviewed like a tgz; without build output or package.json it is refused", async () => {
    await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt") });
    expect((await refresh(id)).statusCode).toBe(200);

    const nb = await importEntry(id, "no-build");
    expect(nb.statusCode, nb.body).toBe(422);
    expect(nb.json().error.code).toBe("catalog.invalid_manifest");
    expect(nb.json().error.message).toContain("the plugin has an extension but no build output");
    const np = await importEntry(id, "no-pkg");
    expect(np.statusCode, np.body).toBe(422);
    expect(np.json().error.code).toBe("catalog.invalid_manifest");
    expect(np.json().error.message).toContain(
      "a plugin with an extension needs package.json with peerDependencies",
    );
    await nothingImported();

    const ext = await importEntry(id, "git-ext");
    expect(ext.statusCode, ext.body).toBe(200);
    expect(ext.json().review).toMatchObject({
      name: "git-ext",
      packageName: "@acme/plugin-git-ext",
      extension: { name: "git-ext", action: "install" },
      source: { kind: "git", detail: { path: "plugins/git-ext" } },
    });
    await confirm(ext.json());
    expect(await version("git-ext")).toMatchObject({
      source: "git",
      package_name: "@acme/plugin-git-ext",
    });
  });

  it("git entries: a pinned commit stays pinned, a ref is resolved at import and recorded as following the branch", async () => {
    await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt") });
    expect((await refresh(id)).statusCode).toBe(200);

    const a = await importEntry(id, "remote-a");
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().review).toMatchObject({
      version: "1.0.0",
      source: {
        kind: "git",
        detail: { repo: "remote-a.git", path: ".", commit: remoteA1, followsBranch: false },
      },
    });
    await confirm(a.json());
    expect((await version("remote-a")).source_detail).toMatchObject({
      commit: remoteA1,
      followsBranch: false,
    });

    const b = await importEntry(id, "remote-b");
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().review.source.detail).toEqual({
      host: new URL(other.url("x")).host,
      repo: "remote-b.git",
      path: ".",
      ref: "main",
      commit: remoteB,
      followsBranch: true,
    });
  });

  it("switching the form clears the other form's field (mirrors -> git, ref -> http)", async () => {
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces",
      payload: {
        name: "Switch",
        url: "https://m.example.com/marketplace.json",
        mirrors: ["https://m2.example.com/marketplace.json"],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    const toGit = await admin({
      method: "PATCH",
      url: `/api/v1/admin/marketplaces/${id}`,
      payload: { url: "acme/tools", ref: "main" },
    });
    expect(toGit.statusCode, toGit.body).toBe(200);
    expect(toGit.json()).toMatchObject({
      form: "git",
      url: "https://github.com/acme/tools.git",
      ref: "main",
      mirrors: [],
    });
    const toHttp = await admin({
      method: "PATCH",
      url: `/api/v1/admin/marketplaces/${id}`,
      payload: { url: "https://m.example.com/marketplace.json" },
    });
    expect(toHttp.statusCode, toHttp.body).toBe(200);
    expect(toHttp.json()).toMatchObject({ form: "http", ref: null });
  });

  it("allowedHosts: an entry on another host is not importable and its import is refused", async () => {
    await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt") });
    expect((await refresh(id)).statusCode).toBe(200);
    const res = await importEntry(id, "outside");
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("marketplace.host_not_allowed");
    expect(res.json().error.message).toContain("git.example.com");
    await nothingImported();
  });

  it("a pinned commit the server will not serve is refused with a hint to pin a tip", async () => {
    const bad = "1".repeat(40);
    await marketplaceRepo([
      {
        name: "gone",
        summary: { en: "gone" },
        source: { git: { url: other.url("remote-b"), commit: bad } },
      },
    ]);
    const id = await addGit({ url: srv.url("mkt") });
    expect((await refresh(id)).statusCode).toBe(200);
    const res = await importEntry(id, "gone");
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error.code).toBe("marketplace.git_failed");
    expect(res.json().error.message).toContain(
      `the server refused to serve commit ${bad}; pin a branch or tag tip instead`,
    );
    await nothingImported();
  });

  it("the marketplace token reaches only the marketplace origin", async () => {
    await marketplaceRepo();
    const id = await addGit({ url: srv.url("mkt"), token: TOKEN });
    expect((await refresh(id)).statusCode).toBe(200);
    expect((await importEntry(id, "git-skills")).statusCode).toBe(200);
    expect((await importEntry(id, "remote-b")).statusCode).toBe(200);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === BASIC)).toBe(true);
    expect(other.requests.length).toBeGreaterThan(0);
    expect(other.requests.every((q) => q.authorization === undefined)).toBe(true);
  });
});

describe("direct git import", () => {
  it("POST import/git stages a review from a repo (ref, path) without creating a marketplace", async () => {
    await other.commit("multi", {
      ...under("plugins/alpha", skill("alpha")),
      "README.md": "multi\n",
    });
    const res = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/git",
      payload: { url: other.url("multi"), ref: "main", path: "plugins/alpha" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const head = res.json().review.source.detail.commit as string;
    expect(res.json().review).toMatchObject({
      name: "alpha",
      version: `0.0.0-git.g${head.slice(0, 12)}`,
      packageName: null,
      publisher: new URL(other.url("x")).host,
      source: {
        kind: "git",
        detail: { repo: "multi.git", path: "plugins/alpha", ref: "main", followsBranch: true },
      },
    });
    expect(res.json().review.source.marketplaceId).toBeUndefined();
    await confirm(res.json());
    expect(await version("alpha")).toMatchObject({ source: "git", marketplace_id: null });
    const marketplaces = await db.selectFrom("marketplaces").select("id").execute();
    expect(marketplaces.map((m) => m.id)).toEqual(["official"]);

    const whole = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/git",
      payload: { url: other.url("remote-b") },
    });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.json().review).toMatchObject({
      name: "remote-b",
      version: "1.2.0",
      source: { detail: { path: ".", commit: remoteB, followsBranch: true } },
    });

    for (const path of ["../x", "/x", "a/../b"]) {
      const bad = await admin({
        method: "POST",
        url: "/api/v1/admin/catalog/import/git",
        payload: { url: other.url("multi"), path },
      });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.json().error.code).toBe("validation_failed");
      expect(bad.json().error.message).toMatch(/^path:/);
    }

    const plain = await admin({
      method: "POST",
      url: "/api/v1/admin/catalog/import/git",
      payload: { url: "http://git.example.com/a/b.git" },
    });
    expect(plain.statusCode, plain.body).toBe(400);
    expect(plain.json().error.code).toBe("validation_failed");
  });
});

describe("item identity", () => {
  const importGit = (payload: Record<string, unknown>) =>
    admin({ method: "POST", url: "/api/v1/admin/catalog/import/git", payload });

  it("a plugin without package.json adds versions only from the same git source", async () => {
    await other.commit("twin-a", under("twin", skill("twin")));
    await other.commit("twin-b", under("twin", skill("twin")));
    const a = await importGit({ url: other.url("twin-a"), path: "twin" });
    expect(a.statusCode, a.body).toBe(200);
    await confirm(a.json());
    // another repo resolving to the same name is not merged into the item
    const b = await importGit({ url: other.url("twin-b"), path: "twin" });
    expect(b.statusCode, b.body).toBe(409);
    expect(b.json().error.code).toBe("catalog.name_conflict");
    expect(b.json().error.message).toContain(
      `comes from git ${new URL(other.url("x")).host}/twin-a:twin`,
    );
    // the same source at a new commit adds a version
    await other.commit("twin-a", { ...under("twin", skill("twin")), "twin/NOTES.md": "v2\n" });
    const again = await importGit({ url: other.url("twin-a"), path: "twin" });
    expect(again.statusCode, again.body).toBe(200);
    await confirm(again.json());
    expect(await db.selectFrom("catalog_item_versions").select("version").execute()).toHaveLength(
      2,
    );
  });

  it("never mixes an npm-named item with a plugin without package.json", async () => {
    const named = await pluginFiles({
      manifest: { name: "mixed" },
      packageName: "@acme/plugin-mixed",
      files: skill("mixed"),
    });
    const { "package.json": _, ...bare } = named;
    await other.commit("mixed-named", named);
    await other.commit("mixed-bare", bare);

    const n = await importGit({ url: other.url("mixed-named") });
    expect(n.statusCode, n.body).toBe(200);
    await confirm(n.json());
    const onto = await importGit({ url: other.url("mixed-bare") });
    expect(onto.statusCode, onto.body).toBe(409);
    expect(onto.json().error.message).toContain("comes from package @acme/plugin-mixed");

    await truncateTables(db, "capybara.catalog_item_versions, capybara.catalog_items");
    const b = await importGit({ url: other.url("mixed-bare") });
    expect(b.statusCode, b.body).toBe(200);
    await confirm(b.json());
    const back = await importGit({ url: other.url("mixed-named") });
    expect(back.statusCode, back.body).toBe(409);
    expect(back.json().error.message).toContain(
      `comes from git ${new URL(other.url("x")).host}/mixed-bare:.`,
    );
    expect(back.json().error.message).toContain("package @acme/plugin-mixed cannot add versions");
  });
});
