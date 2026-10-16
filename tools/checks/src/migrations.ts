import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Finding = { file: string; line: number; rule: string; message: string };

const NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const ALLOW_RE = /^\s*--\s*capybara:allow-destructive(?:\s+(.*\S))?\s*$/;

const MSG_DESTRUCTIVE =
  "先在本版本停止读写该列，下一版本再删除；确需本版本执行请加 -- capybara:allow-destructive <原因>";
const MSG_REASON =
  "-- capybara:allow-destructive 后必须写明原因（不能为空）；原因应说明为何本版本可以直接执行";
const MSG_TX =
  "迁移器已为每个文件包一层事务；去掉事务控制语句。CONCURRENTLY 不能在事务中执行，改用普通 CREATE INDEX IF NOT EXISTS";

type Statement = { text: string; line: number };

/**
 * 把 SQL 切成语句。忽略 `--` 行注释、块注释、单引号字符串（含 '' 转义）与美元引用字符串
 * 中的 `;` 和关键字：注释被丢弃，字符串/美元引用内容被抹成空串。line 为语句首个 token 的 1 基行号。
 */
function splitStatements(src: string): Statement[] {
  const out: Statement[] = [];
  let text = "";
  let line = 1;
  let startLine = 0;
  let i = 0;
  const push = (chunk: string) => {
    if (startLine === 0 && chunk.trim() !== "") startLine = line;
    text += chunk;
  };
  const flush = () => {
    if (text.trim() !== "") out.push({ text: text.replace(/\s+/g, " ").trim(), line: startLine });
    text = "";
    startLine = 0;
  };
  while (i < src.length) {
    const c = src[i] as string;
    const two = src.slice(i, i + 2);
    if (two === "--") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (src.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          if (src[i] === "\n") line++;
          i++;
        }
      }
      push(" ");
      continue;
    }
    if (c === "'") {
      push("'");
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") break;
        else {
          if (src[i] === "\n") line++;
          i++;
        }
      }
      i++;
      push("'");
      continue;
    }
    if (c === '"') {
      push('"');
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') i += 2;
        else if (src[i] === '"') break;
        else {
          if (src[i] === "\n") line++;
          i++;
        }
      }
      i++;
      push('"');
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        const stop = end === -1 ? src.length : end + tag.length;
        push("$$");
        for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      flush();
      i++;
      continue;
    }
    push(c);
    if (c === "\n") line++;
    i++;
  }
  flush();
  return out;
}

const CREATE_RE =
  /^CREATE\s+(?:(?:UNIQUE|UNLOGGED|TEMP|TEMPORARY)\s+)*(TABLE|INDEX|SCHEMA|EXTENSION|SEQUENCE)\s+(?:CONCURRENTLY\s+)?(IF NOT EXISTS\b)?/i;
const TX_RE =
  /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|END|ABORT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const CONCURRENTLY_RE = /^(CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;

/**
 * 检查单个迁移文件的 SQL 文本（不检查文件名）。file 仅用于 finding 输出。
 */
export function checkSql(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");
  const add = (line: number, rule: string, message: string) =>
    findings.push({ file, line, rule, message });

  for (const st of splitStatements(source)) {
    const t = st.text;

    const tx = TX_RE.exec(t);
    if (tx || CONCURRENTLY_RE.test(t)) add(st.line, "transaction-control", MSG_TX);

    const create = CREATE_RE.exec(t);
    if (create && !create[2]) {
      add(st.line, "idempotent", `CREATE ${create[1]?.toUpperCase()} 必须带 IF NOT EXISTS`);
    }
    if (/^DO\b/i.test(t)) {
      add(st.line, "do-block", "迁移不允许 DO 块（其内部语句无法静态审查）；拆成普通幂等语句");
    }

    let dropsColumn = false;
    if (/^DROP\b/i.test(t) && !/\bIF EXISTS\b/i.test(t)) {
      add(st.line, "idempotent", "DROP 必须带 IF EXISTS");
    } else if (/^ALTER\s+TABLE\b/i.test(t)) {
      for (const m of t.matchAll(
        /\bDROP\s+(COLUMN\s+)?(IF\s+EXISTS\s+)?(NOT\s+NULL\b|DEFAULT\b|EXPRESSION\b|IDENTITY\b|CONSTRAINT\b|\S+)/gi,
      )) {
        const kw = (m[3] ?? "").toUpperCase();
        if (!m[1] && /^(NOT\s+NULL|DEFAULT|EXPRESSION|IDENTITY)$/.test(kw)) continue;
        if (!m[1] && kw === "CONSTRAINT") {
          if (!/^\s*(IF\s+EXISTS\b)/i.test(t.slice((m.index ?? 0) + m[0].length))) {
            add(st.line, "idempotent", "DROP CONSTRAINT 必须带 IF EXISTS");
          }
          continue;
        }
        dropsColumn = true;
        if (!m[2]) add(st.line, "idempotent", "DROP COLUMN 必须带 IF EXISTS");
      }
    }

    const destructive =
      dropsColumn ||
      /^DROP\s+(?:TABLE|SCHEMA)\b/i.test(t) ||
      /^TRUNCATE\b/i.test(t) ||
      /^DELETE\s+FROM\b/i.test(t) ||
      /\bRENAME\b/i.test(t) ||
      /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(t);
    if (destructive) {
      const prev = st.line >= 2 ? (lines[st.line - 2] ?? "") : "";
      const allow = ALLOW_RE.exec(prev);
      if (!allow) add(st.line, "destructive", MSG_DESTRUCTIVE);
      else if (!allow[1]) add(st.line, "destructive", MSG_REASON);
    }
  }
  return findings;
}

/**
 * 检查若干迁移目录（不存在的目录被忽略）。规则：naming / idempotent / destructive / transaction-control。
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
          message: "文件名必须匹配 NNNN_<snake_desc>.sql（四位数字、小写字母/数字/下划线）",
        });
        continue;
      }
      findings.push(...checkSql(file, readFileSync(file, "utf8")));
    }
  }
  return findings;
}
