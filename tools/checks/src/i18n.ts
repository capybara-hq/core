import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@formatjs/icu-messageformat-parser";
import type { Finding } from "./source.js";

export type { Finding };

/** 基准文案（key 的权威来源）与需要与之同步的文案。 */
const BASE = "zh.json";
const TARGET = "en.json";

/** 把嵌套 JSON 展平为叶子 key 的点路径（有序）。非对象值（字符串、数组等）都算叶子。 */
export function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => flattenKeys(v, prefix === "" ? k : `${prefix}.${k}`))
    .sort();
}

/**
 * 尽力定位 key 所在行：沿点路径依次查找各段的 `"段名":`，找不到返回 1。
 * 只用于提示，不影响判定。
 */
function lineOf(text: string, path: string): number {
  let at = 0;
  for (const seg of path.split(".")) {
    const i = text.indexOf(`${JSON.stringify(seg)}:`, at);
    if (i < 0) return 1;
    at = i;
  }
  return text.slice(0, at).split("\n").length;
}

/** The string leaves of nested JSON, as `[dot path, message]`. */
function stringLeaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return prefix === "" ? [] : [[prefix, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    stringLeaves(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

/**
 * Every message must parse as ICU MessageFormat the way next-intl parses it (tags on): an
 * unescaped `<x>` or an unbalanced `{` only fails at render time (`IntlError: INVALID_MESSAGE`),
 * where it shows the key instead of the text.
 */
function invalidMessages(file: string, text: string, json: unknown): Finding[] {
  const findings: Finding[] = [];
  for (const [key, message] of stringLeaves(json)) {
    try {
      parse(message);
    } catch (e) {
      findings.push({
        file,
        line: lineOf(text, key),
        rule: "i18n-invalid-message",
        message:
          `「${key}」is not a valid ICU message (${e instanceof Error ? e.message : String(e)}); ` +
          "rephrase it, or quote literal `<` `>` `{` `}` with apostrophes (e.g. '<'name'>')",
      });
    }
  }
  return findings;
}

type Loaded = { file: string; text: string; json: unknown; keys: Set<string> } | Finding;

function load(file: string): Loaded {
  if (!existsSync(file)) {
    return {
      file,
      line: 1,
      rule: "i18n-missing-file",
      message: `文案文件不存在；${BASE} 与 ${TARGET} 必须同时存在`,
    };
  }
  const text = readFileSync(file, "utf8");
  try {
    const json: unknown = JSON.parse(text);
    return { file, text, json, keys: new Set(flattenKeys(json)) };
  } catch (e) {
    return {
      file,
      line: 1,
      rule: "i18n-invalid-json",
      message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 以 zh.json 为基准比较 en.json 的 key 集合（嵌套对象展平为点路径）：
 * en.json 缺少的 key → `i18n-missing-key`，多出的 key → `i18n-extra-key`。
 * A message in either file that is not valid ICU MessageFormat -> `i18n-invalid-message`.
 */
export function checkI18n(messagesDir: string): Finding[] {
  const base = load(join(messagesDir, BASE));
  const target = load(join(messagesDir, TARGET));
  if ("rule" in base || "rule" in target) {
    return [base, target].filter((x): x is Finding => "rule" in x);
  }

  const findings: Finding[] = [
    ...invalidMessages(base.file, base.text, base.json),
    ...invalidMessages(target.file, target.text, target.json),
  ];
  for (const key of base.keys) {
    if (target.keys.has(key)) continue;
    findings.push({
      file: target.file,
      line: 1,
      rule: "i18n-missing-key",
      message: `${TARGET} 缺少 key「${key}」（${BASE} 中存在）；在 en.json 中补上该 key`,
    });
  }
  for (const key of target.keys) {
    if (base.keys.has(key)) continue;
    findings.push({
      file: target.file,
      line: lineOf(target.text, key),
      rule: "i18n-extra-key",
      message: `${TARGET} 多出 key「${key}」（${BASE} 中不存在）；删除该 key，或先在 ${BASE} 中补上`,
    });
  }
  return findings;
}
