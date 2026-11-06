import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sidebar's conversation section layout (spec §6.13): jsdom lays nothing out, so these read
 * the stylesheet's rules.
 */
const sidebar = readFileSync(resolve(import.meta.dirname, "../src/styles/sidebar.css"), "utf8");

/** The declarations of the top-level rules whose selector list has `sel`, joined. */
function decls(sel: string): string {
  const out: string[] = [];
  const text = sidebar.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("the conversation section", () => {
  it("a filter matching nothing draws the compact empty state centered in the list (the DataTable's in-list form)", () => {
    const hint = decls('.cb-sidebar-empty[data-state="no-match"]');
    expect(hint).toContain("padding: var(--cb-space-8) 0;");
    const state = decls(
      '.cb-sidebar-empty[data-state="no-match"] > .cb-empty-state[data-size="compact"]',
    );
    expect(state).toContain("align-items: center;");
    expect(state).toContain("padding: 0;");
    expect(state).toContain("text-align: center;");
  });
});
