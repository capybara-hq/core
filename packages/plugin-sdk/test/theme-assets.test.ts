import { describe, expect, it } from "vitest";
import {
  checkPng,
  checkWoff2,
  type ParsedTheme,
  sanitizeThemeSvg,
  THEME_LIMITS,
  validateThemeAssets,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const svgDoc = (inner: string, rootAttrs = 'viewBox="0 0 10 10"') =>
  `<svg ${SVG_NS} ${rootAttrs}>${inner}</svg>`;

const sanitize = (s: string) => sanitizeThemeSvg(enc(s));
const svgOf = (s: string): string => {
  const r = sanitize(s);
  if ("error" in r) throw new Error(r.error);
  return r.svg;
};
const errorOf = (s: string): string => {
  const r = sanitize(s);
  if (!("error" in r)) throw new Error(`expected an error, got ${r.svg}`);
  return r.error;
};

/** A PNG header (signature + IHDR) with the given size, padded to `bytes`. */
function png(width: number, height: number, bytes = 64): Uint8Array {
  const b = new Uint8Array(Math.max(bytes, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set(enc("IHDR"), 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function woff2(bytes = 64, sig = "wOF2"): Uint8Array {
  const b = new Uint8Array(bytes);
  b.set(enc(sig), 0);
  return b;
}

const theme = (over: Partial<ParsedTheme>): ParsedTheme => ({
  id: "t",
  name: { en: "T", zh: "T" },
  schemes: { dark: {} },
  merged: {},
  singleScheme: "dark",
  ...over,
});

describe("sanitizeThemeSvg", () => {
  it("re-serializes a clean SVG and drops the root width / height / class", () => {
    const out = svgOf(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- c --><svg ${SVG_NS} width="100" height="50" class="x" viewBox="0 0 10 10"><g fill="#fff"><path d="M0 0h10v10z"/></g></svg>`,
    );
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g fill="#fff"><path d="M0 0h10v10z"/></g></svg>',
    );
  });

  it("keeps internal references, titles and escapes text and attribute values", () => {
    const out = svgOf(
      svgDoc(
        '<defs><linearGradient id="a"><stop offset="0" stop-color="#000"/></linearGradient></defs><title>A &amp; B &lt;x&gt;</title><rect fill="url(#a)" width="1" height="1"/><use href="#a"/><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/><text>a<![CDATA[<script>]]>b</text>',
      ),
    );
    expect(out).toContain('<use href="#a"/>');
    expect(out).toContain('<use xlink:href="#a"/>');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out).toContain("<title>A &amp; B &lt;x&gt;</title>");
    expect(out).toContain("<text>a&lt;script&gt;b</text>");
    expect(out).toContain('fill="url(#a)"');
    expect(out).not.toContain("CDATA");
  });

  it("escapes quotes in attribute values", () => {
    expect(svgOf(svgDoc(`<g id='a"b&amp;'/>`))).toContain('<g id="a&quot;b&amp;"/>');
  });

  it("accepts a prefixed SVG namespace and serializes it unprefixed", () => {
    expect(
      svgOf(
        '<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><s:circle r="1"/></s:svg>',
      ),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle r="1"/></svg>');
  });

  it("drops comments and editor metadata in foreign namespaces", () => {
    const out = svgOf(
      `<svg ${SVG_NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 1 1" inkscape:version="1"><sodipodi:namedview><inkscape:grid/></sodipodi:namedview><!-- x --><path d="M0 0" inkscape:label="p"/></svg>`,
    );
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>',
    );
  });

  it.each([
    ["script", svgDoc("<script>alert(1)</script>"), /script/],
    ["foreignObject", svgDoc("<foreignObject><div/></foreignObject>"), /foreignObject/],
    ["style element", svgDoc("<style>*{}</style>"), /style/],
    ["style attribute", svgDoc('<rect style="fill:red"/>'), /style/],
    ["onload", svgDoc('<rect onload="alert(1)"/>'), /onload/],
    ["onload on the root", svgDoc("", 'viewBox="0 0 1 1" onload="x()"'), /onload/],
    ["uppercase on* attribute", svgDoc('<rect ONCLICK="x()"/>'), /ONCLICK/],
    ["external href", svgDoc('<use href="https://x"/>'), /href/],
    [
      "external xlink:href",
      svgDoc('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://x#a"/>'),
      /href/,
    ],
    ["javascript: href", svgDoc('<a href="javascript:alert(1)"><rect/></a>'), /href/],
    ["javascript: anywhere", svgDoc('<rect fill="java&#x09;script:x"/>'), /javascript/],
    ["external url()", svgDoc('<rect fill="url(https://x/a.svg#b)"/>'), /url\(/],
    ["quoted external url()", svgDoc("<rect filter=\"url('//x/f#a')\"/>"), /url\(/],
    ["DOCTYPE", `<!DOCTYPE svg>${svgDoc("")}`, /DOCTYPE/],
    [
      "entity declaration",
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${SVG_NS} viewBox="0 0 1 1">&x;</svg>`,
      /DOCTYPE/,
    ],
    ["undefined entity", svgDoc("<text>&x;</text>"), /not valid XML/],
    ["processing instruction", `<?xml-stylesheet href="a.css"?>${svgDoc("")}`, /processing/],
    [
      "prefixed script",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><s:script>x</s:script></svg>',
      /script/,
    ],
    [
      "XHTML element",
      svgDoc('<h:script xmlns:h="http://www.w3.org/1999/xhtml">x</h:script>'),
      /XHTML/,
    ],
    ["XHTML default namespace", svgDoc('<div xmlns="http://www.w3.org/1999/xhtml"/>'), /XHTML/],
    ["unknown SVG element", svgDoc("<iframe/>"), /iframe/],
    [
      "animate targeting href",
      svgDoc('<a href="#a"><animate attributeName="href" to="#b"/></a>'),
      /animate/,
    ],
    ["set targeting xlink:href", svgDoc('<a><set attributeName="xlink:href" to="#b"/></a>'), /set/],
    [
      "set targeting an event handler",
      svgDoc('<rect><set attributeName="onclick" to="x"/></rect>'),
      /set/,
    ],
    [
      "animate targeting style",
      svgDoc('<rect><animate attributeName="style" to="x"/></rect>'),
      /animate/,
    ],
    ["root not svg", `<g ${SVG_NS}/>`, /root/],
    ["root without the SVG namespace", '<svg viewBox="0 0 1 1"/>', /namespace/],
    ["root without a viewBox", `<svg ${SVG_NS}/>`, /viewBox/],
    ["malformed viewBox", svgDoc("", 'viewBox="0 0 x 1"'), /viewBox/],
    ["not XML", "<svg", /not valid XML/],
    ["non-UTF-8 encoding", `<?xml version="1.0" encoding="ISO-8859-1"?>${svgDoc("")}`, /UTF-8/],
  ])("rejects %s", (_name, input, message) => {
    expect(errorOf(input)).toMatch(message);
  });

  it("rejects invalid UTF-8 and oversized files", () => {
    const bad = sanitizeThemeSvg(new Uint8Array([0x3c, 0xff, 0xfe]));
    expect("error" in bad && bad.error).toMatch(/UTF-8/);
    const big = svgDoc(`<desc>${"a".repeat(THEME_LIMITS.svgBytes)}</desc>`);
    expect(errorOf(big)).toMatch(/larger than/);
  });

  it("allows animation of other attributes", () => {
    expect(
      svgOf(svgDoc('<rect><animate attributeName="opacity" from="0" to="1" dur="1s"/></rect>')),
    ).toContain('attributeName="opacity"');
  });
});

describe("checkWoff2", () => {
  it("accepts a woff2 signature and refuses woff and oversized files", () => {
    expect(checkWoff2(woff2())).toBeUndefined();
    expect(checkWoff2(woff2(64, "wOFF"))).toMatch(/woff2/);
    expect(checkWoff2(new Uint8Array(2))).toMatch(/woff2/);
    expect(checkWoff2(woff2(THEME_LIMITS.fontBytes + 1))).toMatch(/larger than/);
    expect(checkWoff2(woff2(THEME_LIMITS.fontBytes))).toBeUndefined();
  });
});

describe("checkPng", () => {
  it("accepts a PNG at least 64 px high", () => {
    expect(checkPng(png(64, 64))).toBeUndefined();
  });
  it("refuses a short, unsigned, truncated or oversized PNG", () => {
    expect(checkPng(png(32, 32))).toMatch(/64/);
    expect(checkPng(enc("GIF89a------------------------------------"))).toMatch(/PNG/);
    expect(checkPng(png(64, 64).slice(0, 20))).toMatch(/PNG/);
    expect(checkPng(png(64, 64, THEME_LIMITS.pngBytes + 1))).toMatch(/larger than/);
  });
});

describe("validateThemeAssets", () => {
  const svg = enc(svgDoc('<circle r="1"/>', 'width="9" viewBox="0 0 1 1"'));

  it("returns checked fonts and sanitized logos keyed by plugin path", () => {
    const files = new Map([
      ["fonts/a.woff2", woff2()],
      ["logo.svg", svg],
      ["fav.png", png(64, 64)],
    ]);
    const r = validateThemeAssets(
      theme({
        fonts: [{ family: "A", file: "./fonts/a.woff2", weight: 400, role: "prose" }],
        logo: { mark: "./logo.svg", favicon: "fav.png" },
      }),
      files,
    );
    expect(r.errors).toEqual([]);
    expect([...r.assets.keys()].sort()).toEqual(["fav.png", "fonts/a.woff2", "logo.svg"]);
    expect(new TextDecoder().decode(r.assets.get("logo.svg"))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle r="1"/></svg>',
    );
  });

  it("reports unsafe paths, missing files and failing checks", () => {
    const r = validateThemeAssets(
      theme({
        fonts: [
          { family: "A", file: "../x.woff2", weight: 400, role: "prose" },
          { family: "B", file: "./b.woff2", weight: 400, role: "mono" },
          { family: "C", file: "./c.woff2", weight: 400, role: "mono" },
        ],
        logo: { mark: "./bad.svg", favicon: "./small.png" },
      }),
      new Map([
        ["c.woff2", woff2(64, "wOFF")],
        ["bad.svg", enc(svgDoc("<script/>"))],
        ["small.png", png(32, 32)],
      ]),
    );
    expect(r.errors).toEqual([
      expect.stringMatching(/^fonts\.0\.file: .*inside the plugin/),
      expect.stringMatching(/^fonts\.1\.file: .*not found/),
      expect.stringMatching(/^fonts\.2\.file: .*woff2/),
      expect.stringMatching(/^logo\.mark: .*script/),
      expect.stringMatching(/^logo\.favicon: .*64/),
    ]);
    expect(r.assets.size).toBe(0);
  });

  it("refuses assets over 16 MB in total", () => {
    const fonts = Array.from({ length: 8 }, (_, i) => ({
      family: `F${i}`,
      file: `./f${i}.woff2`,
      weight: 400,
      role: "prose" as const,
    }));
    const files = new Map<string, Uint8Array>(
      fonts.map((f) => [f.file.slice(2), woff2(THEME_LIMITS.fontBytes)]),
    );
    files.set("logo.png", png(64, 64));
    const ok = validateThemeAssets(theme({ fonts }), files);
    expect(ok.errors).toEqual([]);
    const over = validateThemeAssets(theme({ fonts, logo: { mark: "./logo.png" } }), files);
    expect(over.errors).toEqual([expect.stringMatching(/16777216 bytes/)]);
  });

  it("counts a file referenced twice once", () => {
    const r = validateThemeAssets(
      theme({ logo: { mark: "./logo.svg", favicon: "logo.svg" } }),
      new Map([["logo.svg", svg]]),
    );
    expect(r.errors).toEqual([]);
    expect(r.assets.size).toBe(1);
  });
});
