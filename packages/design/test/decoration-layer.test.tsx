import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DecorationLayer, DesignProvider, SafeModeBanner } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

/** shell.css without comments, so jsdom applies exactly the primitives' rules (no @layer here). */
const SHELL_CSS = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");

function withStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  document.head.append(style);
  return style;
}

describe("DecorationLayer", () => {
  it("passes clicks through; decoration is hidden from assistive tech, interactive parts are not", () => {
    const style = withStyles();
    try {
      const { container } = render(
        <DesignProvider locale="zh">
          <DecorationLayer>
            <span data-testid="plain">flare</span>
            <div data-testid="boot">
              <span data-testid="scan">scanlines</span>
              <button type="button" data-testid="skip" data-cap-interactive="true">
                skip
              </button>
            </div>
          </DecorationLayer>
        </DesignProvider>,
      );
      const layer = container.querySelector(".cb-decoration") as HTMLElement;
      expect(getComputedStyle(layer).pointerEvents).toBe("none");
      const plain = container.querySelector('[data-testid="plain"]') as HTMLElement;
      const skip = container.querySelector("[data-cap-interactive]") as HTMLElement;
      expect(getComputedStyle(plain).pointerEvents).toBe("none");
      expect(getComputedStyle(skip).pointerEvents).toBe("auto");
      // an interactive element never sits under aria-hidden (the layer itself is not hidden)
      expect(layer.hasAttribute("aria-hidden")).toBe(false);
      expect(skip.closest('[aria-hidden="true"]')).toBeNull();
      // the decoration around it is
      expect(plain.getAttribute("aria-hidden")).toBe("true");
      const scan = container.querySelector('[data-testid="scan"]') as HTMLElement;
      expect(scan.getAttribute("aria-hidden")).toBe("true");
      expect(
        (container.querySelector('[data-testid="boot"]') as HTMLElement).hasAttribute(
          "aria-hidden",
        ),
      ).toBe(false);
    } finally {
      style.remove();
    }
  });

  it("keeps up with a plugin's later DOM: new decoration is hidden, a new focusable is not", async () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <DecorationLayer>
          <div data-testid="host" />
        </DecorationLayer>
      </DesignProvider>,
    );
    const host = container.querySelector('[data-testid="host"]') as HTMLElement;
    expect(host.getAttribute("aria-hidden")).toBe("true");
    // a plugin draws a link into its decoration: focusable, so its subtree leaves aria-hidden
    const a = document.createElement("a");
    a.href = "#skip";
    a.textContent = "skip";
    host.append(a);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.closest('[aria-hidden="true"]')).toBeNull();
    // and back: once the link is gone, the host is decoration again
    a.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.getAttribute("aria-hidden")).toBe("true");
  });

  it("text beside an interactive element is hidden too, without breaking React updates", async () => {
    // every text node with content is hidden from assistive tech unless it is an interactive
    // element's own label
    const exposedText = (root: HTMLElement): string[] => {
      const out: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const text = (n.nodeValue ?? "").trim();
        const el = n.parentElement;
        if (text === "" || el === null) continue;
        if (el.closest('[aria-hidden="true"]') !== null) continue;
        if (el.closest("button, a[href], [data-cap-interactive]") !== null) continue;
        out.push(text);
      }
      return out;
    };
    const Hud = ({ count }: { count: number }) => (
      <>
        boot {count}
        <div data-testid="mixed">
          scanlines {count}
          <button type="button" data-cap-interactive="true">
            skip
          </button>
          tail
        </div>
      </>
    );
    const ui = (count: number) => (
      <DesignProvider locale="zh">
        <DecorationLayer>
          <Hud count={count} />
        </DecorationLayer>
      </DesignProvider>
    );
    const { container, rerender, unmount } = render(ui(1));
    const layer = container.querySelector(".cb-decoration") as HTMLElement;
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await settle();
    expect(exposedText(layer)).toEqual([]);
    // what a person sees is unchanged, in order
    expect(layer.textContent?.replace(/\s+/g, " ").trim()).toBe("boot 1scanlines 1skiptail");
    expect(layer.querySelector("button")?.closest('[aria-hidden="true"]')).toBeNull();
    // the plugin re-renders its text: still hidden, shown once, and React keeps working
    rerender(ui(2));
    await settle();
    expect(exposedText(layer)).toEqual([]);
    expect(layer.textContent?.replace(/\s+/g, " ").trim()).toBe("boot 2scanlines 2skiptail");
    expect(() => unmount()).not.toThrow();
  });

  it("text React removes takes its hidden copy with it", async () => {
    const ui = (show: boolean) => (
      <DesignProvider locale="zh">
        <DecorationLayer>
          <div>
            {show ? "flash" : null}
            <button type="button" data-cap-interactive="true">
              skip
            </button>
          </div>
        </DecorationLayer>
      </DesignProvider>
    );
    const { container, rerender } = render(ui(true));
    const layer = container.querySelector(".cb-decoration") as HTMLElement;
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await settle();
    expect(layer.textContent).toBe("flashskip");
    rerender(ui(false));
    await settle();
    expect(layer.textContent).toBe("skip");
    rerender(ui(true));
    await settle();
    expect(layer.textContent).toBe("flashskip");
  });

  it("covers the viewport above every other layer (z token `decoration`)", () => {
    const rule = /\.cb-decoration \{([^}]*)\}/.exec(SHELL_CSS)?.[1] ?? "";
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("inset: 0");
    expect(rule).toContain("z-index: var(--cb-z-decoration)");
    const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    const z = (name: string) => Number(new RegExp(`--cb-z-${name}: (\\d+);`).exec(tokens)?.[1]);
    for (const other of ["sheet", "dialog", "popover", "toast"])
      expect(z("decoration")).toBeGreaterThan(z(other));
  });

  it("draws no box of its own, nor does the safe mode banner", () => {
    render(
      <DesignProvider locale="zh">
        <DecorationLayer>
          <span>flare</span>
        </DecorationLayer>
        <SafeModeBanner onExit={() => {}} />
      </DesignProvider>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
