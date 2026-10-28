import {
  type FakeGitServer,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { loadFixtureAsStrings } from "./claude-fixtures.js";

/** Refreshing git marketplaces whose repository is a Claude Code marketplace or plugin. */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let k: Kernel;
let admin: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  const config: KernelConfig = runConfig(
    { pg: pgc.url, redis: rd.url },
    { roles: ["api"], marketplaces: { allowInsecureLoopback: true } },
  );
  k = await createKernel(config, { env: {} });
  await k.start();
  await accountsFor(db).createLocal({
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
  await srv?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
});

async function addGit(repo: string): Promise<string> {
  const res = await admin({
    method: "POST",
    url: "/api/v1/admin/marketplaces",
    payload: { name: `Claude ${repo}`, url: srv.url(repo), form: "git" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
const refresh = async (id: string) => {
  const res = await admin({ method: "POST", url: `/api/v1/admin/marketplaces/${id}/refresh` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const entries = async (id: string) => {
  const res = await admin({
    method: "GET",
    url: `/api/v1/admin/marketplaces/entries?sourceId=${id}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as Record<string, unknown>[];
};
const overlays = async (id: string) =>
  Object.fromEntries(
    (
      await db
        .selectFrom("marketplace_entries")
        .select(["name", "claude"])
        .where("source_id", "=", id)
        .execute()
    ).map((r) => [r.name, r.claude]),
  );

const claudeMarketplace = (plugins: unknown[]) =>
  JSON.stringify({ name: "acme-claude", owner: { name: "Acme Claude" }, plugins });

describe("Claude Code git marketplaces", () => {
  it("a .claude-plugin/marketplace.json repo lists its entries with overlays (superpowers fixture: one path . entry, version 7.0.1 from the entry)", async () => {
    await srv.commit("superpowers", loadFixtureAsStrings("superpowers"));
    const id = await addGit("superpowers");
    const view = await refresh(id);
    expect(view).toMatchObject({ lastStatus: "ok", entryCount: 1, skipped: [] });
    const [e] = await entries(id);
    expect(e).toMatchObject({
      name: "superpowers",
      version: "7.0.1",
      format: "claude-code",
      source: { path: "." },
      summary: {
        en: "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
      },
      importable: true,
    });
    expect(await overlays(id)).toEqual({
      superpowers: { strict: true, components: {}, publisher: "Jesse Vincent" },
    });
    const row = await db
      .selectFrom("marketplaces")
      .select(["owner_name", "last_commit"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.owner_name).toBe("Jesse Vincent");
    // the path entry has the tree oid of the root
    const tree = await db
      .selectFrom("marketplace_entries")
      .select("tree_oid")
      .where("source_id", "=", id)
      .executeTakeFirstOrThrow();
    expect(tree.tree_oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it(".capybara-plugin/marketplace.json wins over .claude-plugin/marketplace.json", async () => {
    await srv.commit("both", {
      ".capybara-plugin/marketplace.json": JSON.stringify({
        schemaVersion: 1,
        name: "native",
        plugins: [{ name: "native-one", summary: { en: "n" }, source: { path: "./p" } }],
      }),
      ".claude-plugin/marketplace.json": claudeMarketplace([{ name: "claude-one", source: "./c" }]),
      "p/skills/n/SKILL.md": SKILL_MD("n"),
      "c/skills/c/SKILL.md": SKILL_MD("c"),
    });
    const id = await addGit("both");
    await refresh(id);
    const list = await entries(id);
    expect(list.map((e) => [e.name, e.format])).toEqual([["native-one", "capybara"]]);
    expect(await overlays(id)).toEqual({ "native-one": null });
  });

  it("a repo with only .claude-plugin/plugin.json is a single-plugin marketplace named by it", async () => {
    await srv.commit("solo-repo", {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "solo",
        version: "0.3.0",
        description: "One Claude plugin",
      }),
      "hooks/hooks.json": JSON.stringify({ hooks: {} }),
      "skills/solo/SKILL.md": SKILL_MD("solo"),
    });
    const id = await addGit("solo-repo");
    await refresh(id);
    const list = await entries(id);
    expect(list.map((e) => [e.name, e.version, e.source, e.summary])).toEqual([
      ["solo", "0.3.0", { path: "." }, { en: "One Claude plugin" }],
    ]);

    // an unusable name fails the refresh with the reason
    await srv.commit("bad-solo", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "Bad Name" }),
      "skills/x/SKILL.md": SKILL_MD("x"),
    });
    const bad = await addGit("bad-solo");
    const res = await admin({ method: "POST", url: `/api/v1/admin/marketplaces/${bad}/refresh` });
    const v = await k.marketplaces.get(bad);
    expect(res.json().error.code).toBe("marketplace.invalid");
    expect(v.lastStatus).toBe("error");
    expect(v.lastError).toContain(".claude-plugin/plugin.json name must match");
  });

  it("skipped entries are shown on the marketplace and replaced on the next refresh", async () => {
    await srv.commit("skips", {
      ".claude-plugin/marketplace.json": claudeMarketplace([
        { name: "kept", source: "./kept", strict: false, skills: ["./kept/skills/k"] },
        { name: "from-npm", source: { source: "npm", package: "@acme/x" } },
        { name: "Bad.Name", source: "./bad" },
        { name: "runner", source: { source: "command", command: "x" } },
      ]),
      "kept/skills/k/SKILL.md": SKILL_MD("k"),
    });
    const id = await addGit("skips");
    const view = await refresh(id);
    expect(view.skipped).toEqual([
      { name: "from-npm", reason: "claude_npm_unpinned" },
      { name: "Bad.Name", reason: "invalid_name" },
      { name: "runner", reason: "claude_source_unsupported" },
    ]);
    expect(await overlays(id)).toEqual({
      kept: {
        strict: false,
        components: { skills: ["./kept/skills/k"] },
        publisher: "Acme Claude",
      },
    });
    const listed = await admin({ method: "GET", url: "/api/v1/admin/marketplaces" });
    expect(listed.json().items.find((m: { id: string }) => m.id === id)?.skipped).toHaveLength(3);

    await srv.commit("skips", {
      ".claude-plugin/marketplace.json": claudeMarketplace([{ name: "kept", source: "./kept" }]),
      "kept/skills/k/SKILL.md": SKILL_MD("k"),
    });
    const again = await refresh(id);
    expect(again.skipped).toEqual([]);
    expect(await overlays(id)).toEqual({
      kept: { strict: true, components: {}, publisher: "Acme Claude" },
    });
  });
});
