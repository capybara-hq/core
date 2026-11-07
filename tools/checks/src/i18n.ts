import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isLiteralElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  type MessageFormatElement,
  parse,
} from "@formatjs/icu-messageformat-parser";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  parseFile,
  walk,
} from "./source.js";

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

/**
 * The text of a message a reader sees: its literal parts, including the bodies of plural and
 * select branches and of rich-text tags, but not argument names or select keys (`{agent}`,
 * `{kind, select, agent {…}}`). A message that does not parse (reported by
 * `i18n-invalid-message`) falls back to the message with every `{…}` removed.
 */
function visibleText(message: string): string {
  try {
    const parts: string[] = [];
    const walk = (elements: MessageFormatElement[]): void => {
      for (const el of elements) {
        if (isLiteralElement(el)) parts.push(el.value);
        else if (isPluralElement(el) || isSelectElement(el)) {
          for (const option of Object.values(el.options)) walk(option.value);
        } else if (isTagElement(el)) walk(el.children);
      }
    };
    walk(parse(message));
    return parts.join("\u0000");
  } catch {
    return message.replace(/\{[^{}]*\}/g, "\u0000");
  }
}

/**
 * Words the Chinese UI does not use (spec 2026-11-05 §13.4, §13.4c): 企业 (the deployment layer is
 * 平台, its admin 超级管理员, a non-official marketplace 自定义市场源), and the Latin word "agent"
 * (智能体; names in `{placeholders}` are not text).
 */
const ZH_BANNED: { rule: string; pattern: RegExp; fix: string }[] = [
  {
    rule: "i18n-zh-enterprise",
    pattern: /企业/,
    fix: "the Chinese UI has no 企业: write 超级管理员 for the admin, 平台 for the deployment layer, 自定义市场源 for a non-official marketplace",
  },
  {
    rule: "i18n-zh-agent",
    pattern: /\bagents?\b/i,
    fix: "the Chinese UI says 智能体 (子智能体, 智能体模板); a {placeholder} named agent is fine",
  },
  {
    rule: "i18n-zh-subagent",
    pattern: /子代理/,
    fix: "the Chinese UI says 子智能体, never 子代理",
  },
];

/** 企业 or the Latin word agent in the text of a Chinese message. */
function zhBannedWords(file: string, text: string, json: unknown): Finding[] {
  return stringLeaves(json).flatMap(([key, message]) => {
    const visible = visibleText(message);
    return ZH_BANNED.filter((b) => b.pattern.test(visible)).map((b) => ({
      file,
      line: lineOf(text, key),
      rule: b.rule,
      message: `「${key}」(${JSON.stringify(message)}): ${b.fix}`,
    }));
  });
}

/** One entry of the design system's zh object: `"key": "string literal",` on one line. */
const DESIGN_ENTRY = /^\s*"([^"\\]+)":\s*("(?:[^"\\]|\\.)*"),?\s*$/;

/**
 * The zh strings of the design system (`packages/design/src/i18n.ts`, a `const zh = { … }` object of
 * one-line `"key": "text"` entries) follow the same word rules as the web's zh messages
 * (`i18n-zh-enterprise`, `i18n-zh-agent`). A line of the object that is not such an entry (a
 * concatenation, a template literal, a value split over lines) cannot be confirmed statically and is
 * reported as `i18n-design-unreadable`, as is a file without the object.
 */
export function checkDesignI18n(file: string): Finding[] {
  if (!existsSync(file)) {
    return [{ file, line: 1, rule: "i18n-missing-file", message: `${file} does not exist` }];
  }
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^const zh\b.*=\s*\{\s*$/.test(l));
  if (start < 0) {
    return [
      {
        file,
        line: 1,
        rule: "i18n-design-unreadable",
        message: "no `const zh = {` object found; the zh word rules cannot be confirmed statically",
      },
    ];
  }
  const findings: Finding[] = [];
  for (let i = start + 1; i < lines.length && !/^\}/.test(lines[i] as string); i++) {
    const l = lines[i] as string;
    if (/^\s*(?:\/\/.*)?$/.test(l)) continue;
    const m = DESIGN_ENTRY.exec(l);
    let message: string | undefined;
    try {
      message = m ? (JSON.parse(m[2] as string) as string) : undefined;
    } catch {
      message = undefined;
    }
    if (!m || message === undefined) {
      findings.push({
        file,
        line: i + 1,
        rule: "i18n-design-unreadable",
        message: `${l.trim()} cannot be confirmed statically; write the entry as one "key": "text" line`,
      });
      continue;
    }
    const key = m[1] as string;
    const visible = visibleText(message);
    for (const b of ZH_BANNED.filter((x) => x.pattern.test(visible))) {
      findings.push({
        file,
        line: i + 1,
        rule: b.rule,
        message: `「${key}」(${JSON.stringify(message)}): ${b.fix}`,
      });
    }
  }
  return findings;
}

/**
 * The zh strings the kernel and the SDK ship to the UI (`{ zh: "…", en: "…" }` label objects such as
 * the model purposes, tool display summaries, channel phrases) follow the same zh word rules. Every
 * `zh:` property whose value is a string or template literal under the given source directories is
 * checked (a template's interpolations are not text); test files are skipped. A `zh:` value that is
 * not a literal (a variable, a call) is not text here and is skipped.
 */
export function checkSourceZh(dirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of dirs) {
    for (const f of listSourceFiles(dir)) {
      if (f.isTest) continue;
      const parsed = parseFile(f.file);
      if (isParseError(parsed)) {
        findings.push(parsed);
        continue;
      }
      walk(parsed.program, (n: Node) => {
        if (n.type !== "Property" || n.computed === true) return;
        const key = n.key as Node;
        const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : "";
        if (name !== "zh") return;
        const value = n.value as Node;
        let text: string | undefined;
        if (value.type === "Literal" && typeof value.value === "string") text = value.value;
        else if (value.type === "TemplateLiteral") {
          const quasis = value.quasis as { value: { cooked: string | null; raw: string } }[];
          text = quasis.map((q) => q.value.cooked ?? q.value.raw).join("\u0000");
        }
        if (text === undefined) return;
        const shown = text.split("\u0000").join("{…}");
        for (const b of ZH_BANNED.filter((x) => x.pattern.test(text))) {
          findings.push({
            file: f.file,
            line: parsed.lineOf(n.start),
            rule: b.rule,
            message: `zh: (${JSON.stringify(shown)}): ${b.fix}`,
          });
        }
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
 * A message in either file that is not valid ICU MessageFormat -> `i18n-invalid-message`; a
 * title / label / button message ending with a period -> `i18n-label-period`; "..." in a message ->
 * `i18n-ellipsis`; a half-width ? ! : ; right after a CJK character in zh -> `i18n-cjk-halfwidth`;
 * 企业 in the text of a zh message -> `i18n-zh-enterprise`; the Latin word agent (or agents) in
 * the text of a zh message, placeholders excluded -> `i18n-zh-agent`.
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
    ...zhBannedWords(base.file, base.text, base.json),
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
