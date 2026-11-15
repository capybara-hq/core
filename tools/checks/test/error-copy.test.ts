import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "@capybara-hq/kernel";
import { describe, expect, it } from "vitest";

/**
 * The web app shows an API error by looking up its code under `errors.*` in its messages
 * (`apps/web/src/lib/use-error-message.ts`); a code without copy shows the generic text, so a renamed
 * code whose key was not renamed would silently lose its message. A code may instead carry an object
 * of copy by its detail `reason`, which then needs a `default` (what the web shows for any other
 * reason) and only non-empty strings.
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

  it("an object of reasons needs a default and non-empty entries", () => {
    expect(hasCopy({ gone: "Gone.", default: "Not now." })).toBe(true);
    expect(hasCopy({ gone: "Gone." })).toBe(false);
    expect(hasCopy({ gone: "", default: "Not now." })).toBe(false);
    expect(hasCopy({ gone: { nested: "x" }, default: "Not now." })).toBe(false);
    expect(hasCopy("")).toBe(false);
  });
});
