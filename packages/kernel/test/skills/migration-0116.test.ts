import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0116_skills_default_on.sql (skills default-on spec §5): every agent version loses
 * `skills.orgSkills` / `skills.pinned` (and an emptied `skills`) and gains `disabledSkills: []`;
 * org-made agent template versions lose `selectedSkills`, plugin templates keep it. Migrates to the
 * migration before it, seeds old rows, runs 0116, then runs it again (idempotent).
 */
const FILE = "0116_skills_default_on.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const dirs: string[] = [];

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  dirs.push(dir);
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const base = { name: "A", model: { provider: "p", model: "m" }, disabledTools: [] };

const version = (agentId: string, v: number, definition: unknown) =>
  sql`insert into capybara.agent_versions (agent_id, version, definition, created_by)
    values (${agentId}, ${v}, ${JSON.stringify(definition)}::jsonb, 'a1')`.execute(db);

const definitionOf = async (agentId: string, v: number) =>
  (
    await sql<{ definition: Record<string, unknown> }>`select definition
      from capybara.agent_versions where agent_id = ${agentId} and version = ${v}`.execute(db)
  ).rows[0]?.definition;

const templateDefinition = async (table: "agent" | "platform", id: string) =>
  (table === "agent"
    ? await sql<{ definition: Record<string, unknown> }>`select definition
        from capybara.agent_template_versions where template_id = ${id}`.execute(db)
    : await sql<{ definition: Record<string, unknown> }>`select definition
        from capybara.platform_agent_template_versions where template_id = ${id}`.execute(db)
  ).rows[0]?.definition;

const template = { name: "t", description: "d", instructions: "i", selectedSkills: ["x"] };

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 2), ('ag2', 'o1', 'a1', 'org', 1),
      ('ag3', 'o1', 'a1', 'org', 1)`.execute(db);
  // an old version and the current one, both selecting and pinning
  await version("ag1", 1, { ...base, skills: { orgSkills: ["s1"] } });
  await version("ag1", 2, {
    ...base,
    skills: { orgSkills: ["s1", "s2"], pinned: ["s1"], writePolicy: "ask" },
  });
  // no skills at all
  await version("ag2", 1, base);
  // already in the new shape (a version written by new code before the migration ran)
  await version("ag3", 1, { ...base, disabledSkills: [{ kind: "skill", skillId: "s9" }] });
  // an org-made template (no plugin, no item) and a plugin template
  await sql`insert into capybara.agent_templates
    (id, org_id, name, plugin_name, current_version) values
    ('t-org', 'o1', 't', null, 1), ('t-plugin', 'o1', 't', 'pl', 1)`.execute(db);
  await sql`insert into capybara.agent_template_versions (template_id, version, definition) values
    ('t-org', 1, ${JSON.stringify(template)}::jsonb),
    ('t-plugin', 1, ${JSON.stringify(template)}::jsonb)`.execute(db);
  await sql`insert into capybara.platform_agent_templates
    (id, plugin_name, name, current_version) values
    ('pt-org', null, 't', 1), ('pt-plugin', 'pl', 't', 1)`.execute(db);
  await sql`insert into capybara.platform_agent_template_versions
    (template_id, version, definition) values
    ('pt-org', 1, ${JSON.stringify(template)}::jsonb),
    ('pt-plugin', 1, ${JSON.stringify(template)}::jsonb)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

const expectMigrated = async () => {
  expect(await definitionOf("ag1", 1)).toEqual({ ...base, disabledSkills: [] });
  expect(await definitionOf("ag1", 2)).toEqual({
    ...base,
    skills: { writePolicy: "ask" },
    disabledSkills: [],
  });
  expect(await definitionOf("ag2", 1)).toEqual({ ...base, disabledSkills: [] });
  expect(await definitionOf("ag3", 1)).toEqual({
    ...base,
    disabledSkills: [{ kind: "skill", skillId: "s9" }],
  });
  const { selectedSkills: _s, ...withoutSelected } = template;
  expect(await templateDefinition("agent", "t-org")).toEqual(withoutSelected);
  expect(await templateDefinition("agent", "t-plugin")).toEqual(template);
  expect(await templateDefinition("platform", "pt-org")).toEqual(withoutSelected);
  expect(await templateDefinition("platform", "pt-plugin")).toEqual(template);
};

describe("0116_skills_default_on", () => {
  it("drops selected and pinned skills from every agent version and turns nothing off", async () => {
    await expectMigrated();
  });

  it("is idempotent", async () => {
    const sqlText = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await db.transaction().execute(async (tx) => {
      await sql`set local search_path to capybara, public`.execute(tx);
      await sql.raw(sqlText).execute(tx);
    });
    await expectMigrated();
  });
});
