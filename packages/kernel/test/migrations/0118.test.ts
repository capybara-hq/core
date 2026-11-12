import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPostgresContainer,
  startTestPostgres,
  type TestContainer,
} from "@capybara-hq/testing";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0118_pgvector.sql (memory plugin spec §6.4): installs pgvector in `public` when the server offers
 * it and the migrating role may create it; otherwise it is a no-op (a notice at most), so a managed
 * PostgreSQL without pgvector, or without the right to create it, still migrates.
 */
const FILE = "0118_pgvector.sql";
const TEXT = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

const migrationsThrough = (last: string) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  dirs.push(dir);
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && f <= last) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const track = (c: TestContainer) => {
  stops.push(() => c.stop());
  return c;
};

/** Run `fn` on one connection to `url`, collecting the server notices it raises. */
async function withClient<T>(
  url: string,
  fn: (c: pg.Client, notices: string[]) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  const notices: string[] = [];
  client.on("notice", (n) => notices.push(n.message ?? ""));
  await client.connect();
  try {
    return await fn(client, notices);
  } finally {
    await client.end();
  }
}

const vectorSchema = (url: string) =>
  withClient(url, async (c) => {
    const r = await c.query<{ schema: string }>(
      "select extnamespace::regnamespace::text as schema from pg_extension where extname = 'vector'",
    );
    return r.rows[0]?.schema ?? null;
  });

afterAll(async () => {
  await Promise.allSettled(stops.map((s) => s()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 120_000);

describe("0118_pgvector on a server with pgvector", () => {
  it("installs vector in public, visible from a plugin schema", async () => {
    const db = track(await startTestPostgres());
    await migrate(db.url, { schema: "capybara", dir: migrationsThrough(FILE) });
    expect(await vectorSchema(db.url)).toBe("public");
    await withClient(db.url, async (c) => {
      await c.query("create schema plugin_x");
      await c.query("set search_path = plugin_x, public");
      const r = await c.query<{ d: number }>("select '[1,2]'::vector <=> '[1,3]'::vector as d");
      expect(r.rows[0]?.d).toBeGreaterThan(0);
      // idempotent: the file runs again without error and changes nothing
      await c.query(`set search_path to capybara, public; ${TEXT}`);
    });
    expect(await vectorSchema(db.url)).toBe("public");
  }, 180_000);

  it("leaves an extension a DBA installed in another schema where it is", async () => {
    const db = track(await startTestPostgres());
    await withClient(db.url, async (c) => {
      await c.query("create schema other");
      await c.query("create extension vector schema other");
    });
    await migrate(db.url, { schema: "capybara", dir: migrationsThrough(FILE) });
    expect(await vectorSchema(db.url)).toBe("other");
  }, 180_000);

  it("only raises a notice for a role that may not create extensions", async () => {
    const db = track(await startTestPostgres());
    const role = `cap_noext_${Math.random().toString(36).slice(2, 10)}`;
    await withClient(db.url, (c) => c.query(`create role ${role} login password 'p'`));
    stops.push(() =>
      withClient(db.url, async (c) => {
        await c.query(`drop role if exists ${role}`);
      }),
    );
    const url = new URL(db.url);
    url.username = role;
    url.password = "p";
    const notices = await withClient(url.toString(), async (c, n) => {
      const r = await c.query<{ create: boolean }>(
        "select has_database_privilege(current_database(), 'CREATE') as create",
      );
      expect(r.rows[0]?.create).toBe(false);
      await c.query(TEXT);
      return n;
    });
    expect(notices.some((m) => /pgvector not installed.*SQLSTATE 42501/.test(m))).toBe(true);
    expect(await vectorSchema(db.url)).toBeNull();
  }, 180_000);

  it("only raises a notice when the server refuses CREATE EXTENSION as not supported", async () => {
    // Stands in for a managed server's allow-list (e.g. Azure Flexible Server): an event trigger
    // in this throwaway database rejects CREATE EXTENSION with feature_not_supported (0A000).
    const db = track(await startTestPostgres());
    const notices = await withClient(db.url, async (c, n) => {
      await c.query(`create function refuse_extensions() returns event_trigger language plpgsql as $$
        begin
          raise exception 'extension not allow-listed' using errcode = 'feature_not_supported';
        end $$`);
      await c.query(`create event trigger refuse_extensions on ddl_command_start
        when tag in ('CREATE EXTENSION') execute function refuse_extensions()`);
      await expect(c.query("create extension vector schema public")).rejects.toMatchObject({
        code: "0A000",
      });
      await c.query(TEXT);
      return n;
    });
    expect(notices.some((m) => /pgvector not installed.*SQLSTATE 0A000/.test(m))).toBe(true);
    expect(await vectorSchema(db.url)).toBeNull();
  }, 180_000);
});

describe("0118_pgvector on a server without pgvector", () => {
  it("succeeds and installs nothing", async () => {
    const db = track(await startPostgresContainer({ image: "postgres:17" }));
    await migrate(db.url, { schema: "capybara", dir: migrationsThrough(FILE) });
    expect(await vectorSchema(db.url)).toBeNull();
    const available = await withClient(db.url, async (c) => {
      const r = await c.query("select 1 from pg_available_extensions where name = 'vector'");
      return r.rowCount;
    });
    expect(available).toBe(0);
  }, 180_000);
});
