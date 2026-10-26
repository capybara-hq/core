import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDestructiveBody, isDestructiveSql, splitSqlStatements } from "@capybara-hq/kernel";
import type { Finding } from "./source.js";

export type { Finding };

const NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const ALLOW_RE = /^\s*--\s*capybara:allow-destructive(?:\s+(.*\S))?\s*$/;

const MSG_DESTRUCTIVE =
  "stop reading and writing the column in this version and drop it in the next one; if it must run in this version, add -- capybara:allow-destructive <reason>";
const MSG_REASON =
  "-- capybara:allow-destructive needs a reason (it cannot be empty) saying why this version may run it directly";
const MSG_DO =
  "the statements inside a DO block cannot be reviewed statically: split it into plain idempotent statements if you can; if a DO block is needed (e.g. a RENAME COLUMN guarded by an IF EXISTS test), add -- capybara:allow-destructive <reason> right above the DO line";
const MSG_TX =
  "the migrator already wraps each file in a transaction: remove the transaction control statements. CONCURRENTLY cannot run in a transaction; use a plain CREATE INDEX IF NOT EXISTS";

const CREATE_RE =
  /^CREATE\s+(?:(?:UNIQUE|UNLOGGED|TEMP|TEMPORARY)\s+)*(TABLE|INDEX|SCHEMA|EXTENSION|SEQUENCE)\s+(?:CONCURRENTLY\s+)?(IF NOT EXISTS\b)?/i;
const TX_RE =
  /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|END|ABORT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const CONCURRENTLY_RE = /^(CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;

/**
 * Checks the SQL text of one migration file (not its name); `file` is only used in the findings.
 */
export function checkSql(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");
  const add = (line: number, rule: string, message: string) =>
    findings.push({ file, line, rule, message });

  for (const st of splitSqlStatements(source)) {
    const t = st.text;

    const tx = TX_RE.exec(t);
    if (tx || CONCURRENTLY_RE.test(t)) add(st.line, "transaction-control", MSG_TX);

    const create = CREATE_RE.exec(t);
    if (create && !create[2]) {
      add(st.line, "idempotent", `CREATE ${create[1]?.toUpperCase()} needs IF NOT EXISTS`);
    }
    const prev = st.line >= 2 ? (lines[st.line - 2] ?? "") : "";
    const allow = ALLOW_RE.exec(prev);
    const isDo = /^DO\b/i.test(t);
    if (isDo && !allow) add(st.line, "do-block", MSG_DO);

    let dropsColumn = false;
    if (/^DROP\b/i.test(t) && !/\bIF EXISTS\b/i.test(t)) {
      add(st.line, "idempotent", "DROP needs IF EXISTS");
    } else if (/^ALTER\s+TABLE\b/i.test(t)) {
      for (const m of t.matchAll(
        /\bDROP\s+(COLUMN\s+)?(IF\s+EXISTS\s+)?(NOT\s+NULL\b|DEFAULT\b|EXPRESSION\b|IDENTITY\b|CONSTRAINT\b|\S+)/gi,
      )) {
        const kw = (m[3] ?? "").toUpperCase();
        if (!m[1] && /^(NOT\s+NULL|DEFAULT|EXPRESSION|IDENTITY)$/.test(kw)) continue;
        if (!m[1] && kw === "CONSTRAINT") {
          if (!/^\s*(IF\s+EXISTS\b)/i.test(t.slice((m.index ?? 0) + m[0].length))) {
            add(st.line, "idempotent", "DROP CONSTRAINT needs IF EXISTS");
          }
          continue;
        }
        dropsColumn = true;
        if (!m[2]) add(st.line, "idempotent", "DROP COLUMN needs IF EXISTS");
      }
    }

    if (
      dropsColumn ||
      isDestructiveSql(t) ||
      (isDo && (allow !== null || st.bodies.some(isDestructiveBody)))
    ) {
      if (!allow) add(st.line, "destructive", MSG_DESTRUCTIVE);
      else if (!allow[1]) add(st.line, "destructive", MSG_REASON);
    }
  }
  return findings;
}

/**
 * Checks migration directories (missing ones are ignored). Rules: naming / idempotent / destructive /
 * transaction-control / do-block.
 */
export function checkMigrations(dirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    for (const name of entries) {
      const file = join(dir, name);
      if (!NAME_RE.test(name)) {
        findings.push({
          file,
          line: 1,
          rule: "naming",
          message:
            "the file name must match NNNN_<snake_desc>.sql (four digits, lowercase letters / digits / underscores)",
        });
        continue;
      }
      findings.push(...checkSql(file, readFileSync(file, "utf8")));
    }
  }
  return findings;
}
