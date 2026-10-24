import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "@capybara-hq/kernel";
import { describe, expect, it } from "vitest";

/**
 * The web app shows an API error by looking up its code under `errors.*` in its messages
 * (`apps/web/src/lib/use-error-message.ts`); a code without copy shows the generic text, so a renamed
 * code whose key was not renamed would silently lose its message.
 */
const messagesDir = fileURLToPath(new URL("../../../apps/web/messages/", import.meta.url));

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${messagesDir}${locale}.json`, "utf8")) as Record<
    string,
    unknown
  >;
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
        if (typeof copy !== "string" || copy.trim() === "")
          missing.push(`${locale}: errors.${code}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
