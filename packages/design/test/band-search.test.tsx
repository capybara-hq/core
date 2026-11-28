// The ground band's search field (layered shell spec §2, desktop client spec §7.3, maintainer
// decision 2026-11-28): CSS shows it in any band (start or end) but on a conversation, and
// band-search.tsx hides it where it would overlap the band row's content or the window controls;
// while it shows, the sidebar's search button gives way.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider } from "../src/index";
import { BandSearch } from "../src/shell/band-search";
import { css, parseCss } from "./css-rules";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--cb-shell-controls-x");
  document.documentElement.style.removeProperty("--cb-shell-controls-width");
});

type Box = { left: number; top: number; width: number; height: number };
/** Lays the elements out by class: jsdom has no layout. */
function layout(boxes: Record<string, Box>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const key = Object.keys(boxes).find((k) => this.classList.contains(k));
    const b = key ? boxes[key] : { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...b,
      x: b?.left ?? 0,
      y: b?.top ?? 0,
      right: (b?.left ?? 0) + (b?.width ?? 0),
      bottom: (b?.top ?? 0) + (b?.height ?? 0),
      toJSON: () => b,
    } as DOMRect;
  });
}
const FIELD = { left: 500, top: 10, width: 280, height: 28 };
function shell(onOpen = () => {}) {
  return render(
    <DesignProvider locale="zh">
      <div className="cb-shell">
        <BandSearch onOpen={onOpen} />
        <main className="cb-shell-main">
          <div className="cb-template-head">
            <nav className="cb-pageheader-path">
              <span className="cb-crumb">capybara / agents / support-triage</span>
            </nav>
          </div>
        </main>
      </div>
    </DesignProvider>,
  );
}
const field = () => screen.getByRole("button", { name: "搜索或执行命令" });

describe("the band search field", () => {
  it("is a button with an accessible name and the palette's shortcut, and opens the palette", async () => {
    const onOpen = vi.fn();
    shell(onOpen);
    expect(field().getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    expect(field().textContent).toBe("搜索");
    await userEvent.click(field());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("fits where nothing in the band row lies within 12 px of it", () => {
    layout({ "cb-band-search": FIELD, "cb-crumb": { left: 276, top: 16, width: 200, height: 16 } });
    shell();
    expect(field().dataset.fits).toBe("true");
  });

  it("hides where a long path reaches it, so the sidebar's button comes back", () => {
    layout({ "cb-band-search": FIELD, "cb-crumb": { left: 276, top: 16, width: 220, height: 16 } });
    shell();
    expect(field().dataset.fits).toBe("false");
  });

  it("hides where it would overlap the window controls", () => {
    document.documentElement.style.setProperty("--cb-shell-controls-x", "700px");
    document.documentElement.style.setProperty("--cb-shell-controls-width", "138px");
    layout({ "cb-band-search": FIELD });
    shell();
    expect(field().dataset.fits).toBe("false");
  });

  it("does not fit while CSS hides it (no band, a conversation)", () => {
    layout({});
    shell();
    expect(field().dataset.fits).toBe("false");
  });

  it("measures again when the page changes", async () => {
    layout({ "cb-band-search": FIELD, "cb-crumb": { left: 276, top: 16, width: 200, height: 16 } });
    const { container } = shell();
    expect(field().dataset.fits).toBe("true");
    layout({ "cb-band-search": FIELD, "cb-crumb": { left: 276, top: 16, width: 400, height: 16 } });
    await act(async () => {
      container.querySelector(".cb-crumb")?.append(" / more");
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(field().dataset.fits).toBe("false");
  });
});

describe("where CSS shows the band search (shell-environment.css)", () => {
  const rules = () => parseCss(css("shell-environment.css"));
  const Q = "not style(--cb-shell-paper-drop: 0px)";
  const FIELD_SEL =
    ':root[data-shell="desktop"] .cb-shell:not([data-banner="true"]) > .cb-band-search';
  it("in any band (start or end), centred on the window and on the controls' row", () => {
    expect(
      rules().find((r) => r.at === null && r.selector === ".cb-band-search")?.decls.display,
    ).toBe("none");
    const shown = rules().find((r) => r.at === Q && r.selector === FIELD_SEL);
    expect(shown?.decls.display).toBe("flex");
    expect(shown?.decls.left).toBe("50%");
    expect(shown?.decls.transform).toBe("translateX(-50%)");
    expect(shown?.decls.top).toBe("calc((var(--cb-shell-row) - var(--cb-control-default)) / 2)");
    // it looks like an input
    expect(shown?.decls.background).toBe("var(--cb-field)");
    expect(shown?.decls.border).toBe("1px solid var(--cb-line)");
  });
  it("not on a conversation, whose band row is full; a new conversation keeps it", () => {
    const off = rules().find(
      (r) =>
        r.at === Q &&
        r.selector ===
          ':root[data-shell="desktop"] .cb-shell:has(.cb-shell-main .cb-title-bar:not([data-new])) > .cb-band-search',
    );
    expect(off?.decls.display).toBe("none");
  });
  it("hidden but laid out while it does not fit; the sidebar's button gives way while it shows", () => {
    expect(
      rules().find(
        (r) =>
          r.at === Q &&
          r.selector ===
            ':root[data-shell="desktop"] .cb-shell > .cb-band-search[data-fits="false"]',
      )?.decls.visibility,
    ).toBe("hidden");
    expect(
      rules().find(
        (r) =>
          r.at === Q &&
          r.selector ===
            ':root[data-shell="desktop"] .cb-shell:has(> .cb-band-search[data-fits="true"]) > .cb-sidebar [data-part="search"]',
      )?.decls.display,
    ).toBe("none");
  });
  it("is no drag region: a control in the band", () => {
    expect(css("shell-environment.css")).toMatch(/\.cb-shell-rail-toggle,\s*\.cb-band-search\s*\)/);
  });
});
