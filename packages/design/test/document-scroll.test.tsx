import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationPage, DesignProvider } from "../src/index";

/**
 * The App Shell never scrolls the document (review fix L3). The cause found live: an absolutely
 * positioned element inside the thread's scroller (the working line's screen-reader copy,
 * `.cb-sr-only`) had the initial containing block as its containing block, so the scroller did
 * not clip it and its static position, deep in a long thread, became the document's scrollable
 * overflow; the browser then scrolled the document (about 258 px) while it was mounted. jsdom
 * cannot lay out, so these tests pin the rules that prevent it.
 */
afterEach(cleanup);

const STYLES = resolve(import.meta.dirname, "../src/styles");
const css = (file: string) =>
  readFileSync(resolve(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the top-level rules whose selector list holds `sel` exactly. */
function decls(text: string, sel: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("the document never scrolls under the App Shell", () => {
  it("the thread's scroller is the containing block of what it holds, so it clips it", () => {
    expect(decls(css("conversation-page.css"), ".cb-conv-scroll")).toMatch(/position:\s*relative/);
  });

  it("the shell clips its own overflow and is a containing block", () => {
    const shell = decls(css("shell.css"), ".cb-shell");
    expect(shell).toMatch(/position:\s*relative/);
    expect(shell).toMatch(/overflow:\s*clip/);
    expect(shell).toMatch(/height:\s*100dvh/);
  });

  it("the root does not scroll while an App Shell (not one inside a reference block) is shown", () => {
    const root = decls(css("base.css"), ":root:has(.cb-shell:not(.cb-ref-block .cb-shell))");
    expect(root).toMatch(/overflow:\s*hidden/);
    // pages without the shell (auth pages, /dev/ui reference pages) keep the document's scroll
    expect(decls(css("base.css"), "html")).not.toMatch(/overflow/);
    expect(decls(css("base.css"), "body")).not.toMatch(/overflow/);
  });

  it("the working line's screen-reader copy sits inside the thread's scroller", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <ConversationPage
          titleBar={{
            title: "t",
            untitled: "u",
            menu: [],
            properties: { pressed: false, onToggle: () => {} },
            panels: [],
          }}
          thread={<div>thread</div>}
          working
          composer={<div>composer</div>}
          status={{ context: "c", version: "v" }}
          right="none"
          onCloseRight={() => {}}
        />
      </DesignProvider>,
    );
    const copies = [...container.querySelectorAll(".cb-sr-only")].filter((el) =>
      el.closest('[data-part="thread"]'),
    );
    expect(copies.length).toBeGreaterThan(0);
    for (const el of copies) expect(el.closest(".cb-conv-scroll")).not.toBeNull();
  });
});
