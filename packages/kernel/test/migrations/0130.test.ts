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
 * 0130_auto_mode.sql: the approval kind 'command'; devices.tier dropped; orgs' sandboxTier /
 * sandboxEgress rewritten to autoMode / cloudNetwork; the deployment setting sandboxTiers replaced
 * by devicesAutoMode. Migrates to the migration before it, seeds old-shape values, then runs 0130
 * (and again by hand: idempotent).
 */
const FILE = "0130_auto_mode.sql";

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

const runFile = async () => {
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
};

const settingsOf = async (id: string) =>
  (
    await sql<{ settings: Record<string, unknown> }>`select settings from capybara.orgs
      where id = ${id}`.execute(db)
  ).rows[0]?.settings;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name, settings) values
    ('o_open', 'o-open', 'Open', '{"sandboxTier":{"max":"open","default":"dev"},"sandboxEgress":{"mode":"allowlist","allowHosts":["a.example.com"]},"toolSearch":"off"}'::jsonb),
    ('o_strict', 'o-strict', 'Strict', '{"sandboxTier":{"max":"strict"},"sandboxEgress":{"mode":"none"}}'::jsonb),
    ('o_nomax', 'o-nomax', 'NoMax', '{"sandboxTier":{}}'::jsonb),
    ('o_egress', 'o-egress', 'Egress', '{"sandboxEgress":{"mode":"allowlist"}}'::jsonb),
    ('o_plain', 'o-plain', 'Plain', '{"toolSearch":"on"}'::jsonb)`.execute(db);
  await sql`insert into capybara.deployment_settings (key, value)
    values ('sandboxTiers', '{"max":"open","default":"dev"}'::jsonb)`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o_open', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o_open', 'ag1', 'a1')`.execute(db);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id,
      trigger_seq)
    values ('r1', 'c1', 'waiting', 1, 'a1', 1)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  // idempotent: the file's statements run again without error
  await runFile();
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0130_auto_mode", () => {
  it("the approvals kind CHECK accepts tool, network, git and command", async () => {
    const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'approvals_kind_check' and conrelid = 'capybara.approvals'::regclass`.execute(
      db,
    );
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0]?.def ?? "";
    for (const k of ["tool", "network", "git", "command"]) expect(def).toContain(`'${k}'`);
    expect(def.match(/'[a-z]+'/g)).toHaveLength(4);
    // a command approval is accepted; an unknown kind is not
    await sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
        requested_for, status, expires_at, spec_hash, attempt, kind)
      values ('ap1', 'o_open', 'c1', 'r1', 'call1', 'Bash', 'a1', 'pending',
        now() + interval '1 day', 'h', 1, 'command')`.execute(db);
    await expect(
      sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
          requested_for, status, expires_at, spec_hash, attempt, kind)
        values ('ap2', 'o_open', 'c1', 'r1', 'call2', 'Bash', 'a1', 'pending',
          now() + interval '1 day', 'h', 1, 'other')`.execute(db),
    ).rejects.toThrow(/approvals_kind_check/);
  });

  it("devices.tier is gone", async () => {
    const r = await sql`select column_name from information_schema.columns
      where table_schema = 'capybara' and table_name = 'devices' and column_name = 'tier'`.execute(
      db,
    );
    expect(r.rows).toEqual([]);
  });

  it("orgs: sandboxTier becomes autoMode and sandboxEgress becomes cloudNetwork", async () => {
    expect(await settingsOf("o_open")).toEqual({
      toolSearch: "off",
      autoMode: "allowed",
      cloudNetwork: { mode: "allowlist", allowHosts: ["a.example.com"] },
    });
    // a stored max lower than open turns auto mode off; none becomes an empty allowlist
    expect(await settingsOf("o_strict")).toEqual({
      autoMode: "off",
      cloudNetwork: { mode: "allowlist", allowHosts: [] },
    });
    // no max in the stored tiers is the platform default, lower than open
    expect(await settingsOf("o_nomax")).toEqual({ autoMode: "off" });
    // an allowlist without its own hosts keeps following the deployment's list
    expect(await settingsOf("o_egress")).toEqual({
      cloudNetwork: { mode: "allowlist" },
    });
    // nothing stored: both settings follow the platform (open network, auto by default)
    expect(await settingsOf("o_plain")).toEqual({ toolSearch: "on" });
  });

  it("the deployment setting sandboxTiers becomes devicesAutoMode", async () => {
    // other seeded settings (e.g. uiTheme from 0094) are not this migration's business
    const r = await sql<{ key: string; value: unknown }>`select key, value
      from capybara.deployment_settings where key in ('sandboxTiers', 'devicesAutoMode')
      order by key`.execute(db);
    expect(r.rows).toEqual([{ key: "devicesAutoMode", value: { mode: "allowed" } }]);
  });

  it("a stored platform max lower than open turns auto mode off (run again)", async () => {
    await sql`delete from capybara.deployment_settings where key = 'devicesAutoMode'`.execute(db);
    await sql`insert into capybara.deployment_settings (key, value)
      values ('sandboxTiers', '{"max":"dev"}'::jsonb)`.execute(db);
    await runFile();
    const r = await sql<{ key: string; value: unknown }>`select key, value
      from capybara.deployment_settings where key in ('sandboxTiers', 'devicesAutoMode')
      order by key`.execute(db);
    expect(r.rows).toEqual([{ key: "devicesAutoMode", value: { mode: "off" } }]);
  });
});
