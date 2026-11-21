import { describe, expect, it } from "vitest";
import { css, parseCss } from "./css-rules";

// Mobile app spec §7.1: the touch pass. The web stops feeling like a page on touch, in the browser,
// the PWA and the app alike. The stylesheets are the thing to prove.

const FILES = ["base.css", "controls.css", "shell.css", "sidebar.css", "display.css", "touch.css"];
const rules = FILES.flatMap((f) => parseCss(css(f)));
/** A selector list split at the commas outside parentheses, spaces normalised. */
function selectorsOf(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === "(") depth++;
    else if (selector[i] === ")") depth--;
    else if (selector[i] === "," && depth === 0) {
      out.push(selector.slice(from, i));
      from = i + 1;
    }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim());
}
/** The declarations of every rule with a selector (in a list) equal to `selector`, merged. */
const declsOf = (selector: string) =>
  Object.assign(
    {},
    ...rules.filter((r) => selectorsOf(r.selector).includes(selector)).map((r) => r.decls),
  ) as Record<string, string>;

const TOUCH_TARGETS =
  ':where(a, button, [role="button"], [role="tab"], [role="menuitem"], summary, label, input, select, textarea)';
const FIELDS = ':where(input, textarea, [contenteditable]:not([contenteditable="false"]))';

/**
 * The interactive design classes. The brief's `.cb-card[href]` does not exist (a card is not a link),
 * `.cb-sidebar-item` stands for the sidebar's items and `.cb-bottomnav a` is `.cb-bottomnav-item`;
 * the sidebar's more row and conversation title button are interactive too.
 */
const INTERACTIVE = [
  ".cb-btn",
  ".cb-icon-btn",
  ".cb-row-link",
  ".cb-bottomnav-item",
  ".cb-sidebar-item",
  ".cb-sidebar-more",
  ".cb-sidebar-conv",
  // the chat-first compact shell (Task 27): the floating button, the drawer's rows, its search,
  // account row and new-conversation button, and the account sheet's rows (NavRow too)
  ".cb-float-btn",
  ".cb-navrow",
  ".cb-navdrawer-search",
  ".cb-navdrawer-account",
  ".cb-navdrawer-new",
];

describe("touch behaviour", () => {
  it("controls draw no tap highlight and take no double-tap zoom", () => {
    const d = declsOf(TOUCH_TARGETS);
    expect(d["-webkit-tap-highlight-color"]).toBe("transparent");
    expect(d["touch-action"]).toBe("manipulation");
  });

  it.each(INTERACTIVE)("%s has a pressed state", (cls) => {
    const pressed = rules.some((r) =>
      selectorsOf(r.selector).some(
        (s) =>
          s.includes(cls) &&
          !new RegExp(`${cls.replace(".", "\\.")}[\\w-]`).test(s) &&
          /:active\b|\[data-pressed\]/.test(s),
      ),
    );
    expect(pressed, `${cls} needs an :active or [data-pressed] rule`).toBe(true);
  });

  it("every .cb-btn variant has its own pressed rule above the generic one", () => {
    const variants = [
      ...new Set(
        [...css("controls.css").matchAll(/\.cb-btn\[data-variant="([\w-]+)"\]/g)].map((m) => m[1]),
      ),
    ];
    expect(variants.length).toBeGreaterThanOrEqual(6);
    for (const v of variants) {
      const sel = `.cb-btn[data-variant="${v}"]:active:not(:disabled)`;
      const d = declsOf(sel);
      expect(d.background, `${v} needs ${sel}`).toBeTruthy();
      expect(d.background).not.toBe("var(--cb-hover)");
    }
  });

  it.each([".cb-shell-float", ".cb-sidebar", ".cb-btn", ".cb-icon-btn"])(
    "%s is not selectable and has no long-press callout",
    (cls) => {
      const d = declsOf(cls);
      expect(d["user-select"]).toBe("none");
      expect(d["-webkit-touch-callout"]).toBe("none");
    },
  );

  it("never blocks selection of prose, code or fields", () => {
    const offenders = rules
      .filter((r) => r.decls["user-select"] === "none")
      .flatMap((r) => selectorsOf(r.selector))
      .filter((s) => /\.cb-prose(?![\w-])|(^|[\s>+~(])(pre|code|input|textarea)(?![\w-])/.test(s));
    expect(offenders).toEqual([]);
    const fields = declsOf(FIELDS);
    expect(fields["user-select"]).toBe("text");
  });

  it("the page does not rubber band", () => {
    expect(declsOf("html")["overscroll-behavior"]).toBe("none");
    expect(declsOf(".cb-shell")["overscroll-behavior"]).toBe("none");
  });

  it("pinch zoom stays: no stylesheet restricts zoom", () => {
    const all = FILES.map(css)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(all).not.toMatch(/user-scalable|maximum-scale/);
    for (const sel of ["html", "body", ".cb-shell"]) {
      expect(declsOf(sel)["touch-action"] ?? "").not.toMatch(/^(none|pan-)/);
    }
  });
});
