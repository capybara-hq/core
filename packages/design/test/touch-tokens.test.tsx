import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { isTouchPointer, TOUCH_QUERY, useTouch } from "../src/index";
import { css, parseCss } from "./css-rules";

// The touch tokens (spec §2.2, §2.5, §2.6, §4.3): one `@media TOUCH_QUERY` block in the generated
// tokens.css holds every override and nothing else; every pre-touch declaration is unchanged; the
// code font role (`--cb-font-code`) keeps Sarasa where the UI font turns into the system font.

const tokensCss = css("tokens.css");
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");
type Block = Record<string, string>;
const pre = JSON.parse(read("fixtures/tokens-pre-touch.json")) as Record<string, Block>;
const json = JSON.parse(read("../../../docs/design/tokens.json")) as {
  size: { touch: Record<string, number> };
};

/** The custom properties of the (first) rule `selector` at the top level of a stylesheet. */
function block(selector: string): Block {
  const rule = parseCss(tokensCss).find((r) => r.at === null && r.selector === selector);
  if (!rule) throw new Error(`tokens.css has no ${selector}`);
  return Object.fromEntries(Object.entries(rule.decls).filter(([k]) => k.startsWith("--")));
}

const SYSTEM = "system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif";
/** The overrides under TOUCH_QUERY: the plan's Task 24 list, spelled out. */
const OVERRIDES: Block = {
  "--cb-font": SYSTEM,
  "--cb-font-prose": SYSTEM,
  "--cb-type-body-size": "17px",
  "--cb-type-body-line": "24px",
  "--cb-type-small-size": "15px",
  "--cb-type-small-line": "20px",
  "--cb-type-micro-size": "13px",
  "--cb-type-micro-line": "18px",
  "--cb-type-h2-size": "22px",
  "--cb-type-h2-line": "28px",
  "--cb-type-h1-size": "28px",
  "--cb-type-h1-line": "34px",
  "--cb-type-prose-size": "17px",
  "--cb-type-prose-line": "26px",
  "--cb-type-prose-small-size": "15px",
  "--cb-type-prose-small-line": "22px",
  "--cb-type-metric-size": "22px",
  "--cb-type-metric-line": "28px",
  "--cb-control-dense": "44px",
  "--cb-control-default": "44px",
  "--cb-control-prominent": "52px",
  "--cb-row-dense": "44px",
  "--cb-row-default": "44px",
  "--cb-row-roomy": "56px",
  "--cb-radius-sm": "12px",
  "--cb-radius-md": "20px",
  "--cb-radius-bubble": "20px",
};

describe("TOUCH_QUERY", () => {
  it("is the one query of the design spec", () => {
    expect(TOUCH_QUERY).toBe(
      "(pointer: coarse), (any-pointer: coarse) and (not (any-pointer: fine))",
    );
  });
});

describe("tokens.css touch block", () => {
  it("has exactly one @media block, with TOUCH_QUERY, holding the overrides and nothing else", () => {
    const media = parseCss(tokensCss).filter((r) => r.at !== null);
    expect(media.map((r) => [r.at, r.selector])).toEqual([[TOUCH_QUERY, ":root"]]);
    expect(media[0]?.decls).toEqual(OVERRIDES);
  });

  it("comes after the scheme blocks", () => {
    expect(tokensCss.indexOf("@media")).toBeGreaterThan(
      tokensCss.indexOf(':root[data-theme="light"]'),
    );
  });

  it("every override names a token the base declares", () => {
    const base = block(":root");
    for (const name of Object.keys(OVERRIDES)) expect(base[name], name).toBeDefined();
  });

  it("touch type sizes are at least 13px", () => {
    for (const [name, v] of Object.entries(OVERRIDES)) {
      if (name.endsWith("-size")) expect(Number.parseInt(v, 10), name).toBeGreaterThanOrEqual(13);
    }
  });

  it("every declaration that existed before the task is unchanged", () => {
    for (const [selector, decls] of Object.entries(pre)) {
      const now = block(selector);
      for (const [name, value] of Object.entries(decls)) {
        expect(now[name], `${selector} ${name}`).toBe(value);
      }
    }
  });

  it("the new tokens exist in both schemes", () => {
    const expected = {
      dark: {
        "--cb-float-ground": "rgba(28,28,26,0.85)",
        "--cb-float-line": "rgba(255,255,255,0.08)",
        "--cb-shadow-float-touch": "0 6px 20px rgba(0,0,0,.35)",
      },
      light: {
        "--cb-float-ground": "rgba(255,255,255,0.85)",
        "--cb-float-line": "rgba(26,26,24,0.08)",
        "--cb-shadow-float-touch": "0 6px 20px rgba(26,26,24,.10)",
      },
    };
    for (const scheme of ["dark", "light"] as const) {
      expect(block(`:root[data-theme="${scheme}"]`)).toMatchObject(expected[scheme]);
    }
    expect(block(":root")).toMatchObject({
      "--cb-font-code": '"Sarasa Mono SC", ui-monospace, monospace',
      "--cb-radius-pill": "999px",
      "--cb-layout-drawer": "320px",
      "--cb-touch-hit": "44px",
      "--cb-touch-float": "48px",
      "--cb-touch-primary": "48px",
      "--cb-touch-prominent": "52px",
      "--cb-touch-composer": "60px",
      "--cb-touch-row": "52px",
      "--cb-touch-row-roomy": "56px",
      "--cb-touch-icon": "22px",
      "--cb-touch-icon-float": "24px",
    });
    expect(json.size.touch).toEqual({
      hit: 44,
      float: 48,
      primary: 48,
      prominent: 52,
      composer: 60,
      row: 52,
      "row-roomy": 56,
      icon: 22,
      "icon-float": 24,
    });
  });
});

/** The audit list: each selector draws code, a command, a path, a version or a time (one each). */
const CODE_SELECTORS: [file: string, selector: string][] = [
  ["base.css", ":where(code, pre, kbd, samp)"],
  ["display.css", ".cb-datetime"],
  ["display.css", ".cb-code-pre"],
  ["display.css", ".cb-keycap-cap"],
  ["display.css", '.cb-kv[data-variant="facts"] .cb-kv-value[data-mono="true"]'],
  ["conversation.css", ".cb-md .cb-code"],
  ["conversation.css", ".cb-md-code"],
  ["conversation.css", ".cb-hcard-json"],
  ["conversation.css", ".cb-text-output-body"],
  ["conversation.css", ".cb-preview-text"],
  ["display.css", ".cb-kbd"],
  ["display.css", ".cb-io-text"],
  ["overlays.css", ".cb-dialog-confirm code"],
  ["controls.css", '.cb-textarea textarea[data-code="true"]'],
  ["templates.css", ".cb-item-list-code"],
  ["schedule-calendar.css", ".cb-scal-error-code"],
  ["conversation.css", ".cb-tool-command"],
  ["conversation.css", ".cb-tool-output"],
  ["conversation.css", ".cb-diff"],
  ["conversation.css", ".cb-hcard-root-path"],
  ["conversation-page.css", ".cb-title-path"],
  ["conversation-page.css", ".cb-task-command"],
  ["conversation-page.css", ".cb-task-output-detail"],
  ["shell.css", ".cb-pageheader-path"],
  ["shell.css", ".cb-statusbar-right"],
  ["table.css", '.cb-cell-title-desc[data-mono="true"]'],
  ["templates.css", ".cb-copy-field-value > .cb-input"],
  ["templates.css", ".cb-error-detail-raw"],
];

describe("the code font role", () => {
  it.each(CODE_SELECTORS)("%s %s declares font-family: var(--cb-font-code)", (file, selector) => {
    const rules = parseCss(css(file)).filter((r) => r.selector === selector && r.at === null);
    expect(rules.length, `${file} has no ${selector}`).toBeGreaterThan(0);
    const mine = rules.filter((r) => r.decls["font-family"] === "var(--cb-font-code)");
    expect(mine.length).toBeGreaterThan(0);
    // a `font` shorthand after the family would reset it to the inherited font
    for (const r of mine) {
      const keys = Object.keys(r.decls);
      if (keys.includes("font")) {
        expect(keys.indexOf("font"), `${selector}: font after font-family`).toBeLessThan(
          keys.indexOf("font-family"),
        );
      }
    }
  });

  /** Code-like selectors that rightly keep the UI font or inherit the code font: one reason each. */
  const EXEMPT: Record<string, string> = {
    ".cb-code": "the frame of a code block; its text is .cb-code-pre",
    ".cb-code-lang": "the language label, UI text",
    ".cb-code-head": "the head of a code block, UI text",
    ".cb-code-title": "the title of a code block, UI text",
    ".cb-code-head-lang": "the language label, UI text",
    '.cb-code[data-framed="false"]': "the unframed block's box",
    '.cb-code[data-framed="false"] > .cb-code-lang': "the language label, UI text",
    '.cb-code[data-framed="false"] > .cb-code-head': "the head of a code block, UI text",
    ".cb-code-pre code": "inherits the code font from .cb-code-pre",
    ".cb-sidebar-kbd": "a shortcut hint in the UI skeleton",
    ".cb-palette-item > .cb-kbd": "placement only; the face is .cb-kbd's",
  };
  const codeLike = (selector: string, decls: Record<string, string>) => {
    const last = selector.split(/[\s>+~]+/).at(-1) ?? selector;
    const byName =
      /(^|\.)(code|kbd|samp|pre)\b|^(code|kbd|samp|pre)\b|-(code|kbd|json)\b|\[data-code/.test(
        last,
      );
    const preformatted = decls.font === "inherit" && /^pre/.test(decls["white-space"] ?? "");
    return byName || preformatted;
  };

  it("no code, pre or kbd-like rule outside the audit list keeps the UI font", () => {
    const dir = resolve(import.meta.dirname, "../src/styles");
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".css"))) {
      if (f === "fonts.css" || f === "tokens.css") continue;
      const rules = parseCss(css(f)).filter((r) => r.at === null);
      const covered = new Set(
        rules
          .filter((r) => r.decls["font-family"] === "var(--cb-font-code)")
          .flatMap((r) => r.selector.split(",").map((x) => x.trim())),
      );
      for (const r of rules) {
        for (const sel of r.selector.split(",").map((x) => x.trim())) {
          if (!codeLike(sel, r.decls) || covered.has(sel) || sel in EXEMPT) continue;
          missing.push(`${f} ${sel}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("no stylesheet but fonts.css and tokens.css names Sarasa", () => {
    const dir = resolve(import.meta.dirname, "../src/styles");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".css"))) {
      if (f === "fonts.css" || f === "tokens.css") continue;
      expect(css(f).replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/sarasa/i);
    }
  });
});

describe("useTouch and isTouchPointer", () => {
  const original = window.matchMedia;
  afterEach(() => {
    cleanup();
    window.matchMedia = original;
  });

  /** A matchMedia whose answers `state` decides per query, with change listeners per query. */
  function fakeMedia(initial: string[]) {
    let matching = initial;
    const listeners = new Map<string, Set<() => void>>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matching.includes(query);
      },
      media: query,
      addEventListener: (_: string, l: () => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(l);
        listeners.set(query, set);
      },
      removeEventListener: (_: string, l: () => void) => listeners.get(query)?.delete(l),
    })) as unknown as typeof window.matchMedia;
    return (next: string[]) => {
      matching = next;
      act(() => {
        for (const set of listeners.values()) for (const l of set) l();
      });
    };
  }

  function Probe() {
    return <>{String(useTouch())}</>;
  }

  it("is null on the server and during hydration", () => {
    expect(renderToString(<Probe />)).toBe("null");
  });

  it("follows matchMedia after hydration", () => {
    const set = fakeMedia([]);
    const { result } = renderHook(() => useTouch());
    expect(result.current).toBe(false);
    set(["(pointer: coarse)", "(any-pointer: coarse)"]);
    expect(result.current).toBe(true);
    set(["(pointer: fine)", "(any-pointer: fine)", "(any-pointer: coarse)"]);
    expect(result.current).toBe(false);
  });

  it("agrees with isTouchPointer for the four pointer combinations", () => {
    const combos: [string[], boolean][] = [
      [["(pointer: coarse)", "(any-pointer: coarse)"], true],
      [["(any-pointer: coarse)"], true],
      [["(pointer: fine)", "(any-pointer: fine)", "(any-pointer: coarse)"], false],
      [["(pointer: fine)", "(any-pointer: fine)"], false],
    ];
    for (const [matching, touch] of combos) {
      fakeMedia(matching);
      const { result, unmount } = renderHook(() => useTouch());
      expect(result.current).toBe(touch);
      expect(isTouchPointer()).toBe(touch);
      unmount();
    }
  });
});

describe("the spec's touch columns", () => {
  const spec = read("../../../docs/design/spec.md");
  const tokens = JSON.parse(read("../../../docs/design/tokens.json")) as {
    size: { type: Record<string, [number, number]> };
    touch: { size: { type: Record<string, [number, number]> } };
  };

  it("§2.2's type table gives each step's touch size / line height from tokens.json", () => {
    for (const [name, base] of Object.entries(tokens.size.type)) {
      const touch = tokens.touch.size.type[name];
      const row = new RegExp(
        `^\\| \`${name}\` \\| ${base[0]} / ${base[1]} \\| ${touch?.[0]} / ${touch?.[1]} \\|`,
        "m",
      );
      expect(spec, name).toMatch(row);
    }
  });

  it("§2.5 names the touch sizes, the pill radius and the float shadow; §2.1 the float colors", () => {
    for (const needle of ["`--cb-touch-<step>`", "`pill`", "`shadow-float-touch`"]) {
      expect(spec).toContain(needle);
    }
    expect(spec).toMatch(/^\| `float-ground` \|/m);
    expect(spec).toMatch(/^\| `float-line` \|/m);
  });
});
