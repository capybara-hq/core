import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sidebar's conversation section layout (spec §6.13): jsdom lays nothing out, so these read
 * the stylesheet's rules.
 */
const sidebar = readFileSync(resolve(import.meta.dirname, "../src/styles/sidebar.css"), "utf8");
const templates = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");

/** The declarations of the top-level rules in `css` (the sidebar's) whose selector list has `sel`, joined. */
function decls(sel: string, css = sidebar): string {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("the conversation section", () => {
  it("scrolls in a box that runs to the sidebar's edges, so its scrollbar sits on the border; the rows keep their inset", () => {
    const convs = decls(".cb-sidebar-convs");
    expect(convs).toContain("overflow-y: auto;");
    // out over the sidebar's own space.2 side padding, and the same padding back inside
    expect(convs).toContain("margin: 0 calc(-1 * var(--cb-space-2));");
    expect(convs).toContain("padding: var(--cb-space-2) var(--cb-space-2) 0;");
    // the divider above it stays inset like the account row's
    expect(convs).toMatch(/border-image: linear-gradient\(/);
    const sidebarRule = decls(".cb-sidebar");
    expect(sidebarRule).toContain(
      "padding: var(--cb-space-3) var(--cb-space-2) var(--cb-space-2);",
    );
  });

  it("one vertical rhythm: the head, the filter, each agent group and 已归档 are space.1 apart", () => {
    expect(decls(".cb-sidebar-convs")).toContain("gap: var(--cb-space-1);");
    // the groups sit in the list's own column, at the section's gap, never a larger one
    expect(decls(".cb-sidebar-convs-body")).toContain("gap: var(--cb-space-1);");
    expect(decls(".cb-sidebar-group + .cb-sidebar-group")).toBe("");
    expect(decls(".cb-sidebar-group")).not.toMatch(/margin/);
  });

  it("the empty list states draw the panel empty state, centered, space.8 above and below", () => {
    // one rule for empty, archived empty and no match: no special case for a filter
    expect(sidebar.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.cb-sidebar-empty\[data-state/);
    expect(decls(".cb-sidebar-empty")).not.toMatch(/padding/);
    const panel = decls('.cb-empty-state[data-size="panel"]', templates);
    expect(panel).toContain("padding: var(--cb-space-8) var(--cb-space-2);");
    // centered like the page style (the base rule), never the compact left alignment
    expect(panel).not.toMatch(/align-items|text-align/);
  });
});
