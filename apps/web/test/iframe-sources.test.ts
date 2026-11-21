import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * apps/web never writes an iframe: the only sites are `EmbedFrame` and `HtmlDocumentFrame` in
 * `@capybara-hq/design`, which a design test asserts are sandboxed without `allow-same-origin`
 * (the mobile shell's origin gate relies on it, mobile app spec §5.3). A new site here fails this
 * test; route it through those components or extend the guard.
 */
const src = resolve(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.(tsx?|jsx?)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

const rendersIframe = /<iframe\b|(?:createElement|jsxs?|jsxDEV)\(\s*["'`]iframe["'`]/;

describe("apps/web renders no iframe of its own", () => {
  it("has no <iframe> or createElement('iframe') in src", () => {
    const found = sourceFiles(src)
      .filter((f) => rendersIframe.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(found).toEqual([]);
  });
});
