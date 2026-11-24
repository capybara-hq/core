import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeGitServer,
  fakeExtensionEntry,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketplacesService } from "../../src/catalog/marketplaces.service.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { ConfigError } from "../../src/config/types.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";

// Config-managed marketplaces (spec 2026-11-20-bootstrap-extra-manifest §5, §6): rows owned by
// the extra bootstrap manifest, their token from `marketplaces.tokens`, and git usernames.

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

const TOKEN = "managed-s3cret-token-value";
const OTHER_TOKEN = "admin-s3cret-token-value";
const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let k: TestKernel;
let admin: Req;
let svc: MarketplacesService;

/** A git marketplace with one path entry (a skills-only plugin). */
const marketplaceRepo = (repo: string) =>
  srv.commit(repo, {
    ".capybara-plugin/marketplace.json": JSON.stringify({
      schemaVersion: 1,
      name: "Acme managed marketplace",
      owner: { name: "Acme Corp" },
      plugins: [
        {
          name: "git-skills",
          summary: { en: "skills only" },
          source: { path: "./plugins/git-skills" },
        },
      ],
    }),
    "plugins/git-skills/skills/hello/SKILL.md": SKILL_MD("hello"),
  });

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-managed-marketplaces-"));
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api"],
      extensionHost: { dir: pluginsDir },
      marketplaces: {
        allowInsecureLoopback: true,
        allowedHosts: ["127.0.0.1"],
        tokens: { acme: TOKEN },
      },
      extensions: [OBJECT_STORE],
      extensionConfig: {
        "fake-object-store": {
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
  k = await startKernel(config, { env: {} });
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    superAdmin: true,
  });
  admin = await session(k, "root");
  svc = k.app.get(MarketplacesService);
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await srv?.stop();
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.audit_events",
  );
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
  await db.deleteFrom("secrets").where("key", "like", "catalog-token:%").execute();
  srv.requests.length = 0;
});

const list = async () => {
  const res = await admin({ method: "GET", url: "/api/v1/admin/marketplaces" });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as Record<string, unknown>[];
};
const view = async (id: string) => (await list()).find((m) => m.id === id);
const refresh = (id: string) =>
  admin({ method: "POST", url: `/api/v1/admin/marketplaces/${id}/refresh` });
const patch = (id: string, payload: Record<string, unknown>) =>
  admin({ method: "PATCH", url: `/api/v1/admin/marketplaces/${id}`, payload });
const auditJson = async () =>
  JSON.stringify(await db.selectFrom("audit_events").selectAll().execute());

describe("syncExtraFromConfig", () => {
  it("creates config:<name> rows with managed=config", async () => {
    await svc.syncExtraFromConfig([
      { name: "acme", url: srv.url("acme-mkt"), ref: "main", username: "x-token-auth" },
      { name: "plain", url: "https://plugins.example.com/marketplace.json" },
    ]);
    const rows = await db
      .selectFrom("marketplaces")
      .select(["id", "name", "url", "form", "ref", "username", "managed", "builtin", "enabled"])
      .where("id", "like", "config:%")
      .orderBy("id")
      .execute();
    expect(rows).toEqual([
      {
        id: "config:acme",
        name: "acme",
        url: srv.url("acme-mkt"),
        form: "git",
        ref: "main",
        username: "x-token-auth",
        managed: "config",
        builtin: false,
        enabled: true,
      },
      {
        id: "config:plain",
        name: "plain",
        url: "https://plugins.example.com/marketplace.json",
        form: "http",
        ref: null,
        username: null,
        managed: "config",
        builtin: false,
        enabled: true,
      },
    ]);
    expect(await view("config:acme")).toMatchObject({
      managed: "config",
      username: "x-token-auth",
      hasToken: true,
    });
    expect(await view("config:plain")).toMatchObject({
      managed: "config",
      username: null,
      hasToken: false,
    });
    // The config token is never copied into the secrets table
    const secrets = await db
      .selectFrom("secrets")
      .select("key")
      .where("key", "like", "catalog-token:%")
      .execute();
    expect(secrets).toEqual([]);
  });

  it("is idempotent and clears the etag and last commit only when the URL or ref changes", async () => {
    const commit = await marketplaceRepo("acme-sync");
    const entry = { name: "acme", url: srv.url("acme-sync") };
    await svc.syncExtraFromConfig([entry]);
    expect((await refresh("config:acme")).statusCode).toBe(200);
    await svc.syncExtraFromConfig([entry]);
    const same = await db
      .selectFrom("marketplaces")
      .select(["last_commit", "enabled"])
      .where("id", "=", "config:acme")
      .executeTakeFirstOrThrow();
    expect(same.last_commit).toBe(commit);
    // The admin's enable switch survives a sync
    expect((await patch("config:acme", { enabled: false })).statusCode).toBe(200);
    await svc.syncExtraFromConfig([{ ...entry, ref: "main" }]);
    const moved = await db
      .selectFrom("marketplaces")
      .select(["last_commit", "etag", "ref", "enabled"])
      .where("id", "=", "config:acme")
      .executeTakeFirstOrThrow();
    expect(moved).toEqual({ last_commit: null, etag: null, ref: "main", enabled: false });
  });

  it("refuses an invalid username, name or URL as a config error", async () => {
    await expect(
      svc.syncExtraFromConfig([{ name: "acme", url: srv.url("x"), username: "a:b" }]),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      svc.syncExtraFromConfig([{ name: "Bad Name", url: srv.url("x") }]),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      svc.syncExtraFromConfig([{ name: "acme", url: "ftp://example.com/x.git" }]),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(await view("config:acme")).toBeUndefined();
  });

  it("a managed row refuses update and delete with marketplace.config_managed, but enabled can change", async () => {
    await svc.syncExtraFromConfig([{ name: "acme", url: srv.url("acme-guard") }]);
    for (const body of [
      { name: "renamed" },
      { url: srv.url("elsewhere") },
      { ref: "dev" },
      { token: "x" },
      { token: null },
      { username: "oauth2" },
    ]) {
      const res = await patch("config:acme", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error.code).toBe("marketplace.config_managed");
    }
    const del = await admin({ method: "DELETE", url: "/api/v1/admin/marketplaces/config:acme" });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("marketplace.config_managed");
    const off = await patch("config:acme", { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, managed: "config" });
  });

  it("refresh and import of a managed private git marketplace send the config token with its username", async () => {
    await marketplaceRepo("acme-private");
    await svc.syncExtraFromConfig([
      { name: "acme", url: srv.url("acme-private"), username: "x-token-auth" },
    ]);
    const res = await refresh("config:acme");
    expect(res.statusCode, res.body).toBe(200);
    const imp = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces/config:acme/entries/git-skills/import",
      payload: {},
    });
    expect(imp.statusCode, imp.body).toBe(200);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === basic("x-token-auth", TOKEN))).toBe(true);
    expect(await svc.credentials("config:acme")).toEqual({
      token: TOKEN,
      username: "x-token-auth",
    });
  });

  it("shows the owner its marketplace.json names once refreshed, the config name before", async () => {
    await marketplaceRepo("acme-label");
    await svc.syncExtraFromConfig([{ name: "acme", url: srv.url("acme-label") }]);
    expect(await view("config:acme")).toMatchObject({ name: "acme" });
    expect((await refresh("config:acme")).statusCode).toBe(200);
    expect(await view("config:acme")).toMatchObject({ name: "Acme Corp" });
    // The row keeps its config name: the key of the manifest entry and of its token
    const row = await db
      .selectFrom("marketplaces")
      .select("name")
      .where("id", "=", "config:acme")
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("acme");
  });

  it("the token never appears in the marketplace view, audit detail or error", async () => {
    await marketplaceRepo("acme-secret");
    await svc.syncExtraFromConfig([{ name: "acme", url: srv.url("acme-secret") }]);
    expect((await refresh("config:acme")).statusCode).toBe(200);
    expect((await patch("config:acme", { enabled: false })).statusCode).toBe(200);
    expect((await patch("config:acme", { enabled: true })).statusCode).toBe(200);
    srv.failNext(500, `echo ${TOKEN}`);
    const failed = await refresh("config:acme");
    expect(failed.statusCode).toBe(502);
    const refused = await patch("config:acme", { name: "x" });
    expect(refused.statusCode).toBe(409);
    const views = JSON.stringify(await list());
    expect(views).toContain('"hasToken":true');
    for (const text of [views, failed.body, refused.body, await auditJson()]) {
      expect(text).not.toContain(TOKEN);
    }
  });

  it("a name removed from the file keeps the row, managed becomes null, token no longer sent", async () => {
    await marketplaceRepo("acme-gone");
    await svc.syncExtraFromConfig([
      { name: "acme", url: srv.url("acme-gone"), username: "x-token-auth" },
    ]);
    expect((await refresh("config:acme")).statusCode).toBe(200);
    await svc.syncExtraFromConfig([]);
    expect(await view("config:acme")).toMatchObject({
      managed: null,
      hasToken: false,
      enabled: true,
    });
    expect(await svc.credentials("config:acme")).toEqual({ username: "x-token-auth" });
    srv.requests.length = 0;
    // a new commit, so the refresh reads the repository again
    await marketplaceRepo("acme-gone");
    expect((await refresh("config:acme")).statusCode).toBe(200);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === undefined)).toBe(true);
    // now an ordinary custom marketplace: editable and removable
    expect((await patch("config:acme", { name: "Acme (kept)" })).statusCode).toBe(200);
    expect(
      (await admin({ method: "DELETE", url: "/api/v1/admin/marketplaces/config:acme" })).statusCode,
    ).toBe(204);
  });

  it("a process without an extra manifest (undefined) neither writes nor demotes managed rows", async () => {
    // Another replica with the extra manifest synced; this one read no managed row before that
    // commit and syncs now: demoting would undo the other replica's rows (ruling R16)
    await svc.syncExtraFromConfig([{ name: "acme", url: srv.url("acme-race") }]);
    expect(await svc.syncExtraFromConfig(undefined)).toEqual([]);
    expect(await view("config:acme")).toMatchObject({ managed: "config" });
  });

  it("re-promoting a demoted row drops the admin token from secrets", async () => {
    const entry = { name: "acme", url: srv.url("acme-again") };
    await svc.syncExtraFromConfig([entry]);
    await svc.syncExtraFromConfig([]);
    // An admin gives the demoted row a token meant for another host
    const set = await patch("config:acme", { url: srv.url("acme-moved"), token: OTHER_TOKEN });
    expect(set.statusCode, set.body).toBe(200);
    const stored = () =>
      db
        .selectFrom("secrets")
        .select("key")
        .where("key", "=", "catalog-token:config:acme")
        .execute();
    expect(await stored()).toHaveLength(1);
    await svc.syncExtraFromConfig([entry]);
    expect(await stored()).toEqual([]);
    await svc.syncExtraFromConfig([]);
    expect(await view("config:acme")).toMatchObject({ managed: null, hasToken: false });
    await marketplaceRepo("acme-again");
    srv.requests.length = 0;
    expect((await refresh("config:acme")).statusCode).toBe(200);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === undefined)).toBe(true);
  });
});

describe("git usernames of custom marketplaces", () => {
  const add = (payload: Record<string, unknown>) =>
    admin({ method: "POST", url: "/api/v1/admin/marketplaces", payload });

  it("admin add with username stores it; empty username sends x-access-token", async () => {
    await marketplaceRepo("user-a");
    const a = await add({
      name: "A",
      url: srv.url("user-a"),
      token: OTHER_TOKEN,
      username: "x-token-auth",
    });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ username: "x-token-auth", managed: null, hasToken: true });
    expect((await refresh(a.json().id)).statusCode).toBe(200);
    expect(srv.requests.length).toBeGreaterThan(0);
    expect(srv.requests.every((q) => q.authorization === basic("x-token-auth", OTHER_TOKEN))).toBe(
      true,
    );
    expect(await auditJson()).not.toContain(OTHER_TOKEN);

    srv.requests.length = 0;
    await marketplaceRepo("user-b");
    const b = await add({ name: "B", url: srv.url("user-b"), token: OTHER_TOKEN, username: "" });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json().username).toBeNull();
    expect((await refresh(b.json().id)).statusCode).toBe(200);
    expect(
      srv.requests.every((q) => q.authorization === basic("x-access-token", OTHER_TOKEN)),
    ).toBe(true);
  });

  it("update sets and clears the username; an invalid username is refused", async () => {
    const a = await add({ name: "A", url: srv.url("user-c") });
    expect(a.statusCode, a.body).toBe(201);
    const id = a.json().id as string;
    const set = await patch(id, { username: "oauth2" });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().username).toBe("oauth2");
    const cleared = await patch(id, { username: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().username).toBeNull();
    for (const username of ["a:b", "with space", "x".repeat(65)]) {
      expect((await add({ name: "C", url: srv.url("user-d"), username })).statusCode).toBe(400);
      expect((await patch(id, { username })).statusCode).toBe(400);
    }
  });
});
