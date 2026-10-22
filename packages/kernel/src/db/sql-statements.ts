/**
 * 迁移 SQL 的静态切分与「破坏性语句」判断（`tools/checks` 的迁移检查与插件包审阅共用）。
 * 纯函数，不连库。迁移只做扩展：删表 / 删列、TRUNCATE、DELETE、RENAME、改列类型都算破坏性。
 */

export type SqlStatement = {
  text: string;
  line: number;
  /** 语句里美元引用字符串的原文（不含定界符），按出现顺序；`DO $$ … $$` 的块体在这里。 */
  bodies: string[];
};

/**
 * 把 SQL 切成语句。忽略 `--` 行注释、块注释、单引号字符串（含 '' 转义）与美元引用字符串
 * 中的 `;` 和关键字：注释被丢弃，字符串/美元引用内容被抹成空串（美元引用原文另存于 `bodies`）。
 * line 为语句首个 token 的 1 基行号。
 */
export function splitSqlStatements(src: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let text = "";
  let line = 1;
  let startLine = 0;
  let bodies: string[] = [];
  let i = 0;
  const push = (chunk: string) => {
    if (startLine === 0 && chunk.trim() !== "") startLine = line;
    text += chunk;
  };
  const flush = () => {
    if (text.trim() !== "") {
      out.push({ text: text.replace(/\s+/g, " ").trim(), line: startLine, bodies });
    }
    text = "";
    startLine = 0;
    bodies = [];
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
        bodies.push(src.slice(i + tag.length, end === -1 ? src.length : end));
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

/**
 * 语句（{@link splitSqlStatements} 的 text）是否为破坏性语句：DROP TABLE / SCHEMA、ALTER TABLE … DROP [COLUMN]
 * 列（DROP NOT NULL / DEFAULT / EXPRESSION / IDENTITY / CONSTRAINT 不算）、TRUNCATE、DELETE FROM、RENAME、改列类型。
 */
export function isDestructiveSql(t: string): boolean {
  if (/^ALTER\s+TABLE\b/i.test(t)) {
    for (const m of t.matchAll(
      /\bDROP\s+(COLUMN\s+)?(IF\s+EXISTS\s+)?(NOT\s+NULL\b|DEFAULT\b|EXPRESSION\b|IDENTITY\b|CONSTRAINT\b|\S+)/gi,
    )) {
      const kw = (m[3] ?? "").toUpperCase();
      if (!m[1] && /^(NOT\s+NULL|DEFAULT|EXPRESSION|IDENTITY|CONSTRAINT)$/.test(kw)) continue;
      return true;
    }
  }
  return (
    /^DROP\s+(?:TABLE|SCHEMA)\b/i.test(t) ||
    /^TRUNCATE\b/i.test(t) ||
    /^DELETE\s+FROM\b/i.test(t) ||
    /\bRENAME\b/i.test(t) ||
    /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(t)
  );
}

/**
 * `DO` 块体（PL/pgSQL，{@link SqlStatement.bodies}）里是否有破坏性语句：块体按 `;` 切开后，从每个
 * `ALTER` / `DROP` / `TRUNCATE` / `DELETE` 关键字起按 {@link isDestructiveSql} 判断（块体以 `BEGIN` / `IF … THEN`
 * 开头，关键字不在语句首）。嵌套的美元引用一并检查。
 */
export function isDestructiveBody(body: string): boolean {
  for (const st of splitSqlStatements(body)) {
    if (/\bRENAME\b/i.test(st.text)) return true;
    for (const m of st.text.matchAll(/\b(?:ALTER|DROP|TRUNCATE|DELETE)\b/gi)) {
      if (isDestructiveSql(st.text.slice(m.index ?? 0))) return true;
    }
    if (st.bodies.some(isDestructiveBody)) return true;
  }
  return false;
}

/** 一段迁移 SQL 里的破坏性语句（行号 1 基，语句已压成一行）。 */
export function destructiveStatements(sql: string): SqlStatement[] {
  return splitSqlStatements(sql).filter((s) => isDestructiveSql(s.text));
}
