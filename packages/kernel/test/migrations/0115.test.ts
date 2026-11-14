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
 * 0115_network_requests.sql (network ask-to-allow spec §5.3, plan P-D6): catalog requests gain a
 * `detail` and the kind `network_allowlist`, which names no item, entry or agent. Migrates to the
 * migration before it, writes an `enable` request, then runs 0115 (twice: idempotent).
 */
const FILE = "0115_network_requests.sql";

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

const insertRequest = (
  id: string,
  kind: string,
  cols: { item?: string | null; agent?: string | null; detail?: string | null } = {},
) =>
  sql`insert into capybara.catalog_requests (id, org_id, item_id, agent_id, kind, stage,
      requested_by, detail)
    values (${id}, 'o1', ${cols.item ?? null}, ${cols.agent ?? null}, ${kind}, 'org', 'a1',
      ${cols.detail ?? null}::jsonb)`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.catalog_items (id, name, publisher, description, latest_version)
    values ('00000000-0000-0000-0000-000000000001', 'p', 'p', 'd', '1.0.0')`.execute(db);
  await sql`insert into capybara.catalog_requests (id, org_id, item_id, kind, stage, requested_by)
    values ('00000000-0000-0000-0000-0000000000a1', 'o1', '00000000-0000-0000-0000-000000000001',
      'enable', 'org', 'a1')`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
  // idempotent: the file's statements run again without error
  const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await sql.raw(`set search_path to capybara; ${text}`).execute(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ID = (n: number) => `00000000-0000-0000-0000-0000000000b${n}`;

describe("0115_network_requests", () => {
  it("existing requests keep their kind and read no detail", async () => {
    const r = await sql<{ kind: string; detail: unknown }>`select kind, detail
      from capybara.catalog_requests`.execute(db);
    expect(r.rows).toEqual([{ kind: "enable", detail: null }]);
  });

  it("a network_allowlist request needs a detail object and names no item or agent", async () => {
    await insertRequest(ID(1), "network_allowlist", { detail: '{"hosts":["a.example.com"]}' });
    await expect(insertRequest(ID(2), "network_allowlist")).rejects.toThrow(
      /catalog_requests_target_check/,
    );
    await expect(
      insertRequest(ID(3), "network_allowlist", {
        detail: '{"hosts":[]}',
        item: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/catalog_requests_target_check/);
    await expect(
      insertRequest(ID(4), "network_allowlist", { detail: '{"hosts":[]}', agent: "ag1" }),
    ).rejects.toThrow(/catalog_requests_target_check/);
    await expect(
      insertRequest(ID(5), "network_allowlist", { detail: '["a.example.com"]' }),
    ).rejects.toThrow(/catalog_requests_detail_check/);
  });

  it("other kinds keep their target rules; unknown kinds are refused", async () => {
    await insertRequest(ID(6), "connector_setup", { agent: "ag1" });
    await expect(insertRequest(ID(7), "enable")).rejects.toThrow(/catalog_requests_target_check/);
    await expect(
      insertRequest(ID(8), "other", { item: "00000000-0000-0000-0000-000000000001" }),
    ).rejects.toThrow(/catalog_requests_kind_check/);
  });
});
