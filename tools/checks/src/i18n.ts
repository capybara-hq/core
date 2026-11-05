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

/**
 * The last words of a key that name a label rather than a sentence: titles, labels, buttons, tabs,
 * menu items, placeholders (spec §7, "Copy"). Matched on the key's last segment, or the last word
 * of a camelCase segment (`confirmLabel`, `pageTitle`), case-insensitive.
 */
const LABEL_WORDS = new Set([
  "title",
  "label",
  "action",
  "confirm",
  "cancel",
  "submit",
  "button",
  "name",
  "tab",
  "heading",
  "item",
  "menu",
  "placeholder",
]);

function isLabelKey(key: string): boolean {
  const segment = key.split(".").at(-1) ?? "";
  const lastWord = segment.split(/(?=[A-Z])/).at(-1) ?? "";
  return LABEL_WORDS.has(lastWord.toLowerCase());
}

/**
 * Titles, labels, buttons and the like never end with a period ("。" or "."; an ellipsis "..." is
 * fine): full sentences do, labels do not (spec §7, "Copy").
 */
function labelPeriods(file: string, text: string, json: unknown): Finding[] {
  return stringLeaves(json)
    .filter(([key, message]) => isLabelKey(key) && /(?<!\.)[。.]$/.test(message.trimEnd()))
    .map(([key, message]) => ({
      file,
      line: lineOf(text, key),
      rule: "i18n-label-period",
      message:
        `「${key}」is a title / label / button (${JSON.stringify(message)}) and ends with a ` +
        "period; drop it (only full sentences end with 。 or .)",
    }));
}

/** Three dots in a message: the one character "…" is the ellipsis (spec §7.1). */
function ellipses(file: string, text: string, json: unknown): Finding[] {
  return stringLeaves(json)
    .filter(([, message]) => message.includes("..."))
    .map(([key, message]) => ({
      file,
      line: lineOf(text, key),
      rule: "i18n-ellipsis",
      message:
        `「${key}」contains "..." (${JSON.stringify(message)}); ` +
        'write the single character "…" instead',
    }));
}

/** A CJK ideograph directly followed by a half-width ? ! : ; (Chinese text uses ？！：；). */
const CJK_HALFWIDTH = /[\u3400-\u4dbf\u4e00-\u9fff][?!:;]/;

/** Half-width punctuation right after a CJK character, in the Chinese messages only. */
function cjkHalfwidth(file: string, text: string, json: unknown): Finding[] {
  return stringLeaves(json)
    .filter(([, message]) => CJK_HALFWIDTH.test(message))
    .map(([key, message]) => ({
      file,
      line: lineOf(text, key),
      rule: "i18n-cjk-halfwidth",
      message:
        `「${key}」has a half-width ? ! : ; right after a Chinese character ` +
        `(${JSON.stringify(message)}); use the full-width ？ ！ ： ；`,
    }));
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
 * A message in either file that is not valid ICU MessageFormat -> `i18n-invalid-message`; a
 * title / label / button message ending with a period -> `i18n-label-period`; "..." in a message ->
 * `i18n-ellipsis`; a half-width ? ! : ; right after a CJK character in zh -> `i18n-cjk-halfwidth`.
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
    ...labelPeriods(base.file, base.text, base.json),
    ...labelPeriods(target.file, target.text, target.json),
    ...ellipses(base.file, base.text, base.json),
    ...ellipses(target.file, target.text, target.json),
    ...cjkHalfwidth(base.file, base.text, base.json),
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
