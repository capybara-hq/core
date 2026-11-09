import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clientCssProblem } from "../../src/client/client-css.js";

/**
 * The client stylesheet rule shared with the packer: the same vectors run against plugin-tools'
 * `cssRemoteProblem` (packages/plugin-tools/test/pack-client.test.ts), so the import check and the
 * packer cannot drift. Here each vector is wrapped as the packer stores it.
 */

interface Vectors {
  assets: string[];
  vectors: { css: string; ok: boolean; note: string }[];
}

const shared = JSON.parse(
  readFileSync(
    new URL("../../../plugin-tools/test/fixtures/client-css-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

const WRAPPED = (css: string) => `@layer extensions {\n${css}\n}\n`;
const assets = new Set(shared.assets);

describe("clientCssProblem: the layer and the tokenizer (kernel only)", () => {
  const ok = (css: string) => expect(clientCssProblem(css, assets), css).toBeUndefined();
  const bad = (css: string, like: RegExp) =>
    expect(clientCssProblem(css, assets), css).toMatch(like);

  it("accepts a wrapped file with asset and data: URLs, strings and comments", () => {
    ok(WRAPPED('[data-cap-part~="shell"] { background: url(../assets/a.png); }'));
    ok(WRAPPED(':root { --x: "}"; } /* } */ a { b: url("data:image/png;base64,AA==") }'));
    ok(WRAPPED(".cx-p-a { mask: url(#m); content: '{'; }"));
    ok(
      WRAPPED(
        '@media (min-width: 1px) { a { b: c } } @font-face { src: url("../assets/f.woff2") }',
      ),
    );
  });

  it("refuses a file that is not one @layer extensions block", () => {
    bad("a { b: c }", /must start with @layer extensions/);
    bad(`${WRAPPED("a { b: c }")} a { color: red }`, /outside @layer extensions/);
    bad("@layer extensions { a { b: c }", /not closed/);
    bad("@layer extensions { } } a { color: red } @layer extensions {", /outside/);
  });

  it("follows the tokenizer: a brace in a url token or after a broken string still counts", () => {
    // the browser ends the bad url at `)` and then closes the layer at `}`
    bad('@layer extensions { a { b: url(data:x"y) } } .evil { color: red } x" }', /outside/);
    bad("@layer extensions { a { b: url(data:x/*) } } .evil { color: red } */ }", /outside/);
    // an unescaped newline ends a string in the browser
    bad('@layer extensions { a { content: "x\n } } .evil { color: red } " }', /string/);
  });

  it("decodes escapes before the URL and function rules", () => {
    bad(WRAPPED("a { b: url(\\2e\\2e/assets/../../x) }"), /not allowed/);
    // decoded it is the asset itself, which the browser resolves the same way
    ok(WRAPPED('a { b: url("\\2e\\2e/assets/a.png") }'));
    bad(WRAPPED("a { b: \\69mage-set(url(../assets/a.png) 1x) }"), /image-set\(\) is not allowed/);
    bad(WRAPPED('a { b: url("\\a0 data:/../../v1/orgs") }'), /non-ASCII whitespace/);
  });
});

describe("clientCssProblem: the shared vectors", () => {
  for (const v of shared.vectors) {
    it(`${v.ok ? "accepts" : "refuses"} ${v.note}`, () => {
      const problem = clientCssProblem(WRAPPED(v.css), assets);
      if (v.ok) expect(problem, v.css).toBeUndefined();
      else expect(problem, v.css).toBeDefined();
    });
  }
});
