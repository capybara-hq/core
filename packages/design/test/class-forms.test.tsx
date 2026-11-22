import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { useId } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ClassForms, DesignProvider, useClassForm } from "../src/index";
import { matchMediaFor, renderAtClass } from "./width";

const real = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = real;
});

function Probe() {
  return <p data-testid="form">{String(useClassForm())}</p>;
}

const forms = (
  <ClassForms
    compact={<button type="button">Compact action</button>}
    wide={<button type="button">Wide action</button>}
  />
);

const copies = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>("[data-class-form]")].map((e) => e.dataset.classForm);

describe("ClassForms", () => {
  it("server render holds both copies", () => {
    const html = renderToString(<DesignProvider locale="zh">{forms}</DesignProvider>);
    expect(html).toContain('data-class-form="compact"');
    expect(html).toContain('data-class-form="wide"');
    expect(renderToString(<Probe />)).toContain("null");
  });

  it("after hydration at 390 only compact is mounted", () => {
    const { container } = renderAtClass(390, forms);
    expect(copies(container)).toEqual(["compact"]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toBe("Compact action");
  });

  it("after hydration at 1440 only wide", () => {
    const { container } = renderAtClass(1440, forms);
    expect(copies(container)).toEqual(["wide"]);
    expect(screen.getByRole("button").textContent).toBe("Wide action");
  });

  it("medium counts as wide", () => {
    const { container } = renderAtClass(700, forms);
    expect(copies(container)).toEqual(["wide"]);
  });

  it("useClassForm reports the form after hydration", () => {
    renderAtClass(390, <Probe />);
    expect(screen.getByTestId("form").textContent).toBe("compact");
    cleanup();
    renderAtClass(1000, <Probe />);
    expect(screen.getByTestId("form").textContent).toBe("wide");
  });

  it("crossing 600 swaps the copy", () => {
    const { container, resize } = renderAtClass(1440, forms);
    expect(copies(container)).toEqual(["wide"]);
    resize(599);
    expect(copies(container)).toEqual(["compact"]);
    resize(600);
    expect(copies(container)).toEqual(["wide"]);
  });

  it("the pre-hydration hidden copy is inert", () => {
    const mm = matchMediaFor(1440);
    window.matchMedia = mm.matchMedia;
    const ui = <DesignProvider locale="zh">{forms}</DesignProvider>;
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(ui);
    const compact = container.querySelector('[data-class-form="compact"]') as HTMLElement;
    const wide = container.querySelector('[data-class-form="wide"]') as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(container, { attributes: true, subtree: true, attributeFilter: ["inert"] });
    render(ui, { container, hydrate: true });
    const records = observer.takeRecords();
    observer.disconnect();
    // The hidden copy got `inert` before the prune removed it; the shown copy never did.
    expect(records.some((r) => r.target === compact)).toBe(true);
    expect(compact.hasAttribute("inert")).toBe(true);
    expect(records.some((r) => r.target === wide)).toBe(false);
    expect(wide.hasAttribute("inert")).toBe(false);
    expect(compact.isConnected).toBe(false);
  });

  it("prunes without losing focus", () => {
    const mm = matchMediaFor(1440);
    window.matchMedia = mm.matchMedia;
    const ui = <DesignProvider locale="zh">{forms}</DesignProvider>;
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(ui);
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Wide action",
    ) as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    render(ui, { container, hydrate: true });
    expect(copies(container)).toEqual(["wide"]);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("a fractional width between 599 and 600 (zoom) still picks one copy, never marking it inert", () => {
    const mm = matchMediaFor(599.5);
    window.matchMedia = mm.matchMedia;
    const ui = <DesignProvider locale="zh">{forms}</DesignProvider>;
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(ui);
    const compact = container.querySelector('[data-class-form="compact"]') as HTMLElement;
    const wide = container.querySelector('[data-class-form="wide"]') as HTMLElement;
    render(ui, { container, hydrate: true });
    expect(copies(container)).toEqual(["compact"]);
    expect(compact.isConnected).toBe(true);
    expect(compact.hasAttribute("inert")).toBe(false);
    expect(wide.hasAttribute("inert")).toBe(true);
    expect(wide.isConnected).toBe(false);
  });

  it("ids from useId are unique per copy and the shown copy keeps its id through the prune", () => {
    function Labelled({ text }: { text: string }) {
      const id = useId();
      return <span id={id}>{text}</span>;
    }
    const idForms = (
      <ClassForms compact={<Labelled text="compact" />} wide={<Labelled text="wide" />} />
    );
    window.matchMedia = matchMediaFor(1440).matchMedia;
    const ui = <DesignProvider locale="zh">{idForms}</DesignProvider>;
    const container = document.createElement("div");
    document.body.append(container);
    container.innerHTML = renderToString(ui);
    const ids = [...container.querySelectorAll("span")].map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe("");
    expect(new Set(ids).size).toBe(2);
    const wideId = (container.querySelector('[data-class-form="wide"] span') as HTMLElement).id;
    render(ui, { container, hydrate: true });
    const after = [...container.querySelectorAll("span")];
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(wideId);
  });

  it("a client-only mount draws only the matching copy", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { container } = render(<DesignProvider locale="zh">{forms}</DesignProvider>);
    expect(copies(container)).toEqual(["compact"]);
  });

  it("the stylesheet hides each copy on the complement of (min-width: 600px)", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/class-forms.css"), "utf8");
    expect(css).toMatch(
      /@media not all and \(min-width: 600px\)\s*\{[^}]*\[data-class-form="wide"\]/,
    );
    expect(css).toMatch(/@media \(min-width: 600px\)\s*\{[^}]*\[data-class-form="compact"\]/);
    const index = readFileSync(resolve(__dirname, "../src/styles/index.css"), "utf8");
    expect(index).toContain('@import "./class-forms.css" layer(design);');
  });
});
