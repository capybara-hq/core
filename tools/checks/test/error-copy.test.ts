import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "@capybara-hq/kernel";
import { describe, expect, it } from "vitest";

/**
 * The web app shows an API error by looking up its code under `errors.*` in its messages
 * (`apps/web/src/lib/use-error-message.ts`); a code without copy shows the generic text, so a renamed
 * code whose key was not renamed would silently lose its message. A code may instead carry an object
 * of copy by its detail `reason`, which then needs a `default` (what the web shows for any other
 * reason) and only non-empty strings, and the same reasons in every locale: a reason one locale
 * lacks would silently fall back to its `default` there.
 */
const messagesDir = fileURLToPath(new URL("../../../apps/web/messages/", import.meta.url));

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${messagesDir}${locale}.json`, "utf8")) as Record<
    string,
    unknown
  >;
}

const filled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** A string, or an object of reasons with a `default`, every entry non-empty text. */
function hasCopy(copy: unknown): boolean {
  if (filled(copy)) return true;
  if (typeof copy !== "object" || copy === null) return false;
  const entries = Object.values(copy);
  return filled((copy as Record<string, unknown>).default) && entries.every(filled);
}

/** The reason keys of an object of copy, sorted; null for a plain string. */
const reasonsOf = (copy: unknown): string[] | null =>
  typeof copy === "object" && copy !== null ? Object.keys(copy).sort() : null;

/**
 * The codes whose copy by reason differs between the locales: one is an object and the other not,
 * or their reason keys differ (`<code>: <locale> lacks <reason>`).
 */
function reasonMismatches(byLocale: Record<string, Record<string, unknown>>): string[] {
  const locales = Object.keys(byLocale);
  const codes = new Set(locales.flatMap((l) => Object.keys(byLocale[l] ?? {})));
  const out: string[] = [];
  for (const code of [...codes].sort()) {
    const keys = locales.map((l) => reasonsOf(byLocale[l]?.[code]));
    if (keys.every((k) => k === null)) continue;
    const all = new Set(keys.flatMap((k) => k ?? []));
    locales.forEach((l, i) => {
      const have = new Set(keys[i] ?? []);
      for (const reason of all) if (!have.has(reason)) out.push(`${code}: ${l} lacks ${reason}`);
    });
  }
  return out;
}

function lookup(tree: unknown, path: string[]): unknown {
  let node = tree;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

describe("error copy", () => {
  it("every kernel error code has en and zh copy", () => {
    const missing: string[] = [];
    for (const locale of ["en", "zh"]) {
      const messages = load(locale);
      for (const code of Object.keys(ERROR_CODES)) {
        const copy = lookup(messages, ["errors", ...code.split(".")]);
        if (!hasCopy(copy)) missing.push(`${locale}: errors.${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("an object of reasons has the same reasons in en and zh", () => {
    const copies: Record<string, Record<string, unknown>> = {};
    for (const locale of ["en", "zh"]) {
      const messages = load(locale);
      copies[locale] = Object.fromEntries(
        Object.keys(ERROR_CODES).map((code) => [
          code,
          lookup(messages, ["errors", ...code.split(".")]),
        ]),
      );
    }
    expect(reasonMismatches(copies)).toEqual([]);
  });

  it("a reason one locale lacks is reported", () => {
    expect(
      reasonMismatches({
        en: { "skill.x": { gone: "Gone.", removed: "Removed.", default: "No." } },
        zh: { "skill.x": { gone: "没了。", default: "不行。" } },
      }),
    ).toEqual(["skill.x: zh lacks removed"]);
    expect(
      reasonMismatches({
        en: { "skill.x": { gone: "Gone.", default: "No." } },
        zh: { "skill.x": "不行。" },
      }),
    ).toEqual(["skill.x: zh lacks default", "skill.x: zh lacks gone"]);
    expect(reasonMismatches({ en: { a: "A." }, zh: { a: "甲。" } })).toEqual([]);
  });

  it("an object of reasons needs a default and non-empty entries", () => {
    expect(hasCopy({ gone: "Gone.", default: "Not now." })).toBe(true);
    expect(hasCopy({ gone: "Gone." })).toBe(false);
    expect(hasCopy({ gone: "", default: "Not now." })).toBe(false);
    expect(hasCopy({ gone: { nested: "x" }, default: "Not now." })).toBe(false);
    expect(hasCopy("")).toBe(false);
  });
});
