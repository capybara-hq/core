import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCEPTANCE_PROMPT } from "../../src/automations/events/acceptance.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0198_acceptance_prompt.sql: acceptance automations still carrying the old kernel prompt get
 * today's {@link ACCEPTANCE_PROMPT}; an edited prompt and another automation's stay as they are.
 */
const FILE = "0198_acceptance_prompt.sql";
const OLD =
  "This work was assigned to you. Read the assigned item, do what it asks within what you are allowed to do, and report what you did.";

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

const automation = (id: string, origin: string, prompt: string, agent: string) =>
  sql`insert into capybara.automations (id, org_id, account_id, agent_id, name, prompt, trigger,
      mode, origin, status)
    values (${id}, 'o1', 'a1', ${agent}, 'N', ${prompt},
      '{"kind":"event","source":"tracker","types":["item.assigned"],"filter":[]}', 'subject',
      ${origin}, 'active')`.execute(db);

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await automation("old", "acceptance", OLD, "g1");
  await automation("edited", "acceptance", "Triage what the tracker sends me.", "g2");
  await automation("own", "person", OLD, "g3");
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0198_acceptance_prompt", () => {
  it("rewrites only the unedited kernel prompt of acceptance automations", async () => {
    const rows = (
      await sql<{ id: string; prompt: string }>`select id, prompt from capybara.automations
        order by id`.execute(db)
    ).rows;
    expect(rows).toEqual([
      { id: "edited", prompt: "Triage what the tracker sends me." },
      { id: "old", prompt: ACCEPTANCE_PROMPT },
      { id: "own", prompt: OLD },
    ]);
  });
});
