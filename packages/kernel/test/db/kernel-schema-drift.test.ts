import { readFileSync } from "node:fs";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * The hand-written Kysely types (`src/db/kernel-schema.ts`) against a freshly migrated database:
 * every table and column of schema `capybara` is declared, and nothing is declared that the
 * database lacks; nullability is compared where the declared type shows it.
 *
 * Kysely types are compile-time only and TypeScript 7 ships no JS compiler API, so the test reads
 * the source text: `KernelDatabase` maps table -> interface, each interface member is `name: type`.
 * The scanner is deliberately small (comments stripped, members split at depth-0 `;`).
 */

interface DeclaredColumn {
  /** `undefined` when the declared type does not show nullability (an unknown alias). */
  nullable: boolean | undefined;
}

const SOURCE = readFileSync(new URL("../../src/db/kernel-schema.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The members' text of `interface <name> [extends A, B] {`, parents' members included. */
function interfaceBody(name: string): string {
  const header = new RegExp(
    `(?:export )?interface ${name}(?:\\s+extends\\s+([\\w\\s,]+))?\\s*\\{`,
  ).exec(SOURCE);
  if (!header) throw new Error(`interface ${name} not found`);
  const open = header.index + header[0].length - 1;
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    const c = SOURCE[i];
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      const parents = (header[1] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      return [...parents.map(interfaceBody), SOURCE.slice(open + 1, i)].join(";\n");
    }
  }
  throw new Error(`interface ${name} is not closed`);
}

/** Splits at `sep` outside any (), <>, {}, []. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if ("(<{[".includes(c)) depth++;
    // `=>` is not a closing angle bracket.
    if (")>}]".includes(c) && !(c === ">" && text[i - 1] === "=")) depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Whether a type expression is nullable, or undefined when the alias hides it. */
function nullability(type: string): boolean | undefined {
  const t = type.trim();
  const wrapper = /^(Generated|ColumnType|Json)<([\s\S]*)>$/.exec(t);
  if (wrapper) {
    const first = splitTop(wrapper[2] as string, ",")[0] as string;
    return nullability(first);
  }
  if (t === "Ts" || t === "Int8" || t === "Bytea") return false;
  if (t === "TsNullable") return true;
  const parts = splitTop(t, "|").map((p) => p.trim());
  if (parts.includes("null")) return true;
  // A plain alias or generic we cannot see through: only compare when it is clearly a known shape.
  return parts.every((p) => /^(string|number|boolean|bigint|Date|Buffer|"[^"]*"|\d+)$/.test(p))
    ? false
    : undefined;
}

function declaredTables(): Map<string, Map<string, DeclaredColumn>> {
  const tables = new Map<string, Map<string, DeclaredColumn>>();
  for (const member of splitTop(interfaceBody("KernelDatabase"), ";")) {
    const m = /^\s*(\w+)\s*:\s*(\w+)\s*$/.exec(member);
    if (!m) continue;
    const columns = new Map<string, DeclaredColumn>();
    for (const col of splitTop(interfaceBody(m[2] as string), ";")) {
      const c = /^\s*(\w+)\??\s*:\s*([\s\S]+)$/.exec(col);
      if (c) columns.set(c[1] as string, { nullable: nullability(c[2] as string) });
    }
    tables.set(m[1] as string, columns);
  }
  return tables;
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const actual = new Map<string, Map<string, boolean>>();

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const rows = await sql<{ table_name: string; column_name: string; is_nullable: string }>`
    select c.table_name, c.column_name, c.is_nullable
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'capybara' and t.table_type = 'BASE TABLE'
      and c.table_name <> '_migrations'`.execute(db);
  for (const r of rows.rows) {
    const cols = actual.get(r.table_name) ?? new Map<string, boolean>();
    cols.set(r.column_name, r.is_nullable === "YES");
    actual.set(r.table_name, cols);
  }
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
});

describe("kernel-schema.ts matches the migrated database", () => {
  it("declares exactly the tables of schema capybara", () => {
    const declared = declaredTables();
    expect(declared.size).toBeGreaterThan(50);
    expect([...declared.keys()].sort()).toEqual([...actual.keys()].sort());
  });

  it("declares exactly the columns of every table, with matching nullability", () => {
    const problems: string[] = [];
    for (const [table, declared] of declaredTables()) {
      const real = actual.get(table);
      if (!real) continue;
      for (const [name, isNullable] of real) {
        const d = declared.get(name);
        if (!d) problems.push(`${table}.${name}: in the database, not in kernel-schema.ts`);
        else if (d.nullable !== undefined && d.nullable !== isNullable)
          problems.push(
            `${table}.${name}: database ${isNullable ? "nullable" : "not null"}, declared ${d.nullable ? "nullable" : "not null"}`,
          );
      }
      for (const name of declared.keys())
        if (!real.has(name)) problems.push(`${table}.${name}: declared, not in the database`);
    }
    expect(problems).toEqual([]);
  });
});
