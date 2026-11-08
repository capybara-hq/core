import { createHash } from "node:crypto";
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
 * 0098_single_provider_running_first.sql: two enabled providers of one single-provider point left
 * from before the rule. 0097 backfills `enabled_at` from the audit, which may name a provider other
 * than the one the replicas run; 0098 moves the provider with a `loaded` replica status row (the
 * most recent heartbeat) before the others, so the rolling deploy keeps it. Migrates to 0096,
 * seeds, runs 0097 and 0098, then runs 0098 a second time.
 */
const FILE = "0098_single_provider_running_first.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
let before: string;
let upTo: string;

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

async function rerun(): Promise<void> {
  const content = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
  await db.transaction().execute(async (t) => {
    await sql`set local search_path to capybara, public`.execute(t);
    await sql.raw(content).execute(t);
  });
}

const enabledAt = async () =>
  Object.fromEntries(
    (
      await sql<{ name: string; enabled_at: Date | null }>`
        select name, enabled_at from capybara.extension_installs order by name`.execute(db)
    ).rows.map((r) => [r.name, r.enabled_at?.toISOString() ?? null]),
  );

/** The `desired()` order of the enabled ones. */
const loadOrder = async () =>
  (
    await sql<{ name: string }>`
      select name from capybara.extension_installs where desired_state = 'enabled'
      order by enabled_at asc nulls last, installed_at, name`.execute(db)
  ).rows.map((r) => r.name);

async function seed(name: string, provides: string[], state: "enabled" | "disabled") {
  const sha = createHash("sha256").update(name).digest("hex");
  const section = JSON.stringify({ manifest: { name, version: "1.0.0", provides } });
  await sql`insert into capybara.extension_packages
      (sha256, name, package_name, version, size, section, blob_store, source, source_ref)
    values (${sha}, ${name}, ${`@t/${name}`}, '1.0.0', 1, ${section}::jsonb, 'pg', 'file', 'x')`.execute(
    db,
  );
  await sql`insert into capybara.extension_installs
      (name, sha256, version, source, desired_state, installed_at)
    values (${name}, ${sha}, '1.0.0', 'file', ${state}, '2026-01-01T00:00:00Z')`.execute(db);
}

const enabledAudit = (name: string, at: string) =>
  sql`insert into capybara.audit_events (action, target, detail, at)
    values ('extension.enabled', ${name}, '{}'::jsonb, ${at}::timestamptz)`.execute(db);

const status = (replica: string, name: string, state: string, heartbeat: string) =>
  sql`insert into capybara.extension_replica_status
      (replica_id, plugin, version, sha256, source, state, heartbeat_at)
    values (${replica}, ${name}, '1.0.0', null, 'install', ${state}, ${heartbeat}::timestamptz)`.execute(
    db,
  );

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  before = copyMigrations((f) => f < "0097");
  upTo = copyMigrations((f) => f <= FILE);
  await migrate(pg.url, { schema: "capybara", dir: before });
  // sandbox: sbx-old enabled first by the audit, but the replicas run sbx-run (sorted after it)
  await seed("sbx-old", ["sandbox@2"], "enabled");
  await seed("sbx-run", ["sandbox@2"], "enabled");
  await enabledAudit("sbx-old", "2026-02-01T00:00:00Z");
  await enabledAudit("sbx-run", "2026-03-01T00:00:00Z");
  // a stale heartbeat of sbx-old loaded, a newer one of sbx-run loaded: the newest wins
  await status("r1", "sbx-old", "loaded", "2026-03-01T00:00:00Z");
  await status("r2", "sbx-run", "loaded", "2026-03-02T00:00:00Z");
  await status("r2", "sbx-old", "pending", "2026-03-02T00:00:00Z");
  // secret-store: contested but nothing loaded -> 0097's values stay
  await seed("sec-a", ["secret-store@1"], "enabled");
  await seed("sec-b", ["secret-store@1", "tool@1"], "enabled");
  await enabledAudit("sec-a", "2026-02-01T00:00:00Z");
  await enabledAudit("sec-b", "2026-03-01T00:00:00Z");
  // object-store: one enabled provider (loaded), one disabled -> untouched
  await seed("obj-a", ["object-store@1"], "enabled");
  await seed("obj-b", ["object-store@1"], "disabled");
  await enabledAudit("obj-a", "2026-02-01T00:00:00Z");
  await status("r2", "obj-a", "loaded", "2026-03-02T00:00:00Z");
  await migrate(pg.url, { schema: "capybara", dir: upTo });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const dir of [before, upTo]) if (dir) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("0098_single_provider_running_first", () => {
  it("the provider replicas run gets the earliest enabled_at; other points keep 0097's values", async () => {
    expect(await enabledAt()).toEqual({
      "sbx-old": "2026-02-01T00:00:00.000Z",
      "sbx-run": "2026-01-31T23:59:59.999Z",
      "sec-a": "2026-02-01T00:00:00.000Z",
      "sec-b": "2026-03-01T00:00:00.000Z",
      "obj-a": "2026-02-01T00:00:00.000Z",
      "obj-b": null,
    });
    const order = await loadOrder();
    expect(order.indexOf("sbx-run")).toBeLessThan(order.indexOf("sbx-old"));
  });

  it("a second run changes nothing", async () => {
    const once = await enabledAt();
    await rerun();
    expect(await enabledAt()).toEqual(once);
  });
});
