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
  /** The select type includes null. */
  nullable: boolean | "unknown";
}

/** Drops a `//` comment from a line unless the `//` sits inside a string literal. */
function stripLineComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

const SOURCE = readFileSync(new URL("../../src/db/kernel-schema.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map(stripLineComment)
  .join("\n");

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

/** The schema file's own `type X<P> = body;` aliases (and its imported names, known non-null). */
const ALIASES = new Map<string, { params: string[]; body: string }>();
for (const m of SOURCE.matchAll(
  /^(?:export )?type (\w+)(?:<(.*?)>(?=\s*=\s))?\s*=\s*([\s\S]*?);\s*$/gm,
)) {
  const params = splitTop(m[2] ?? "", ",")
    .map((p) => p.trim().split(/\s*=\s*|\s+extends\s+/)[0] as string)
    .filter(Boolean);
  ALIASES.set(m[1] as string, { params, body: m[3] as string });
}
const KNOWN_PLAIN = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "Date",
  "Buffer",
  "Uint8Array",
  "unknown",
]);
for (const m of SOURCE.matchAll(/^import type \{([^}]*)\}/gm))
  for (const n of (m[1] as string).split(","))
    KNOWN_PLAIN.add(
      n
        .trim()
        .split(/\s+as\s+/)
        .pop() as string,
    );
for (const m of SOURCE.matchAll(/^export (?:interface|type) (\w+)/gm))
  KNOWN_PLAIN.add(m[1] as string);

/** Columns whose nullability could not be derived: reported, and the test requires none. */
const unclassified: string[] = [];

/** Whether a type expression is nullable (the select type; aliases and generics resolved). */
function nullability(type: string, where: string): boolean | "unknown" {
  const t = type.trim().replace(/^\|\s*/, "");
  const ref = /^(\w+)(?:<([\s\S]*)>)?$/.exec(t);
  if (ref) {
    const [, name, rawArgs] = ref as unknown as [string, string, string | undefined];
    const args = rawArgs === undefined ? [] : splitTop(rawArgs, ",").map((a) => a.trim());
    if (name === "Generated" || name === "ColumnType") return nullability(args[0] ?? "", where);
    if (name === "Array" || name === "Record" || name === "Partial" || name === "Readonly")
      return false;
    const alias = ALIASES.get(name);
    if (alias) {
      let body = alias.body;
      alias.params.forEach((p, i) => {
        body = body.replace(new RegExp(`\\b${p}\\b`, "g"), args[i] ?? "unknown");
      });
      return nullability(body, where);
    }
  }
  const parts = splitTop(t, "|").map((p) => p.trim());
  if (parts.length > 1)
    return parts.some((p) => p === "null" || (p !== t && nullability(p, where)));
  // `unknown` makes no nullability claim (jsonb columns): compatible with either.
  if (t === "unknown") return "unknown";
  if (t === "null") return true;
  if (ref) {
    if (KNOWN_PLAIN.has(ref[1] as string)) return false;
    unclassified.push(`${where}: ${t}`);
    return false;
  }
  // string / number literal, object literal, array, tuple, function: never null by themselves.
  if (/^(["'`\d{[(]|.*\[\]$)/.test(t)) return false;
  unclassified.push(`${where}: ${t}`);
  return false;
}

function declaredTables(): Map<string, Map<string, DeclaredColumn>> {
  const tables = new Map<string, Map<string, DeclaredColumn>>();
  const duplicates: string[] = [];
  for (const member of splitTop(interfaceBody("KernelDatabase"), ";")) {
    const m = /^\s*(\w+)\s*:\s*(\w+)\s*$/.exec(member);
    if (!m) {
      if (member.trim()) throw new Error(`KernelDatabase member not understood: ${member.trim()}`);
      continue;
    }
    if (tables.has(m[1] as string)) duplicates.push(m[1] as string);
    const columns = new Map<string, DeclaredColumn>();
    const members = splitTop(interfaceBody(m[2] as string), ";").filter((c) => c.trim());
    for (const col of members) {
      const c = /^\s*(\w+)\??\s*:\s*([\s\S]+)$/.exec(col);
      if (!c) throw new Error(`${m[2]}: member not understood: ${col.trim()}`);
      if (columns.has(c[1] as string)) duplicates.push(`${m[1]}.${c[1]}`);
      columns.set(c[1] as string, {
        nullable: nullability(c[2] as string, `${m[1]}.${c[1]}`),
      });
    }
    // Every member is parsed as a column (a dropped member would hide drift).
    if (columns.size + duplicates.filter((d) => d.startsWith(`${m[1]}.`)).length !== members.length)
      throw new Error(`${m[2]}: parsed ${columns.size} columns from ${members.length} members`);
    tables.set(m[1] as string, columns);
  }
  expect(duplicates, "duplicate keys in kernel-schema.ts").toEqual([]);
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
        else if (d.nullable !== "unknown" && d.nullable !== isNullable)
          problems.push(
            `${table}.${name}: database ${isNullable ? "nullable" : "not null"}, declared ${d.nullable ? "nullable" : "not null"}`,
          );
      }
      for (const name of declared.keys())
        if (!real.has(name)) problems.push(`${table}.${name}: declared, not in the database`);
    }
    expect(problems).toEqual([]);
    // No column escapes the nullability comparison (no allowlist needed today).
    expect(unclassified).toEqual([]);
  });
});
