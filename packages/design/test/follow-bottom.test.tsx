import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPage, DesignProvider } from "../src/index";
import { useFollowBottom } from "../src/templates/follow-bottom";

/**
 * The thread opens at its latest message (acceptance: a reload painted the thread from its top,
 * then jumped). CSS anchors the scroller at the bottom, so the server HTML already shows it; the
 * hook adds the follow slack and the fallback for browsers without scroll anchoring. jsdom cannot
 * lay out: the stylesheet rules are pinned as text and the scroll geometry is mocked.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const css = readFileSync(
  resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the top-level rules whose selector list holds `sel` exactly. */
function decls(sel: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

const titleBar = {
  title: "t",
  untitled: "u",
  menu: [],
  properties: { pressed: false, onToggle: () => {} },
  panels: [],
};

describe("the thread's scroller is anchored at the bottom by CSS", () => {
  it("is a reversed column, so its scroll origin is the bottom before any script runs", () => {
    const rule = decls('.cb-conv-scroll:not([data-center="true"])');
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column-reverse/);
  });

  it("keeps a short thread at the top and the thread's width", () => {
    const rule = decls(".cb-conv-scroll > .cb-conv-thread");
    expect(rule).toMatch(/margin-bottom:\s*auto/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/flex:\s*none/);
  });

  it("reverses only the one wrapper: the items keep their top-to-bottom order", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <ConversationPage
          titleBar={titleBar}
          thread={[<p key="a">first</p>, <p key="b">second</p>]}
          composer={<div>c</div>}
          status={{ context: "", version: "" }}
          right="none"
          onCloseRight={() => {}}
        />
      </DesignProvider>,
    );
    const scroll = container.querySelector(".cb-conv-scroll") as HTMLElement;
    expect(scroll.children.length).toBe(1);
    expect(scroll.firstElementChild?.getAttribute("data-part")).toBe("thread");
    const texts = [...scroll.querySelectorAll("p")].map((p) => p.textContent);
    expect(texts).toEqual(["first", "second"]);
  });
});

describe("useFollowBottom in a reversed scroller", () => {
  /** 40 px per <p>, a 100 px viewport; scrollTop runs from -(range) up to 0 (the bottom). */
  function mockReversedLayout() {
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.querySelectorAll("p").length * 40;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      v: number,
    ) {
      tops.set(this, Math.min(0, Math.max(v, -(this.scrollHeight - this.clientHeight))));
    });
  }
  function Thread({ n }: { n: number }) {
    const ref = useFollowBottom<HTMLDivElement>();
    return (
      <div ref={ref} data-testid="s" style={{ display: "flex", flexDirection: "column-reverse" }}>
        <div>
          {Array.from({ length: n }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static case
            <p key={i}>m {i}</p>
          ))}
        </div>
      </div>
    );
  }
  const scrollTo = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };
  const tick = () => new Promise((res) => setTimeout(res, 0));

  it("never scrolls on attach: a reader who scrolled up before hydration stays", () => {
    mockReversedLayout();
    const set = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")?.set as (
      v: number,
    ) => void;
    const spy = vi.mocked(set);
    spy.mockClear();
    render(<Thread n={10} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("within 48 px of the bottom it snaps back to the bottom as content grows", async () => {
    mockReversedLayout();
    const r = render(<Thread n={10} />);
    const el = r.getByTestId("s");
    scrollTo(el, -40);
    r.rerender(<Thread n={11} />);
    await vi.waitFor(() => expect(el.scrollTop).toBe(0));
  });

  it("scrolled up, the visible content stays put without scroll anchoring", async () => {
    mockReversedLayout();
    vi.stubGlobal("CSS", { supports: () => false });
    const r = render(<Thread n={10} />);
    const el = r.getByTestId("s");
    scrollTo(el, -200); // 100 px from the top
    r.rerender(<Thread n={12} />); // 80 px more below
    await vi.waitFor(() => expect(el.scrollTop).toBe(-280));
    vi.unstubAllGlobals();
  });

  it("scrolled up, it leaves the position to the browser's scroll anchoring", async () => {
    mockReversedLayout();
    vi.stubGlobal("CSS", { supports: () => true });
    const r = render(<Thread n={10} />);
    const el = r.getByTestId("s");
    scrollTo(el, -200);
    r.rerender(<Thread n={12} />);
    await tick();
    expect(el.scrollTop).toBe(-200);
    vi.unstubAllGlobals();
  });
});

describe("useFollowBottom keeps the topmost visible item still without scroll anchoring", () => {
  /**
   * A laid-out reversed scroller (history paging spec §6): 40 px per <p> in one wrapper, a 100 px
   * viewport at y 0; the content's top sits at -(range + scrollTop), so every <p> measures.
   */
  function mockMeasuredLayout() {
    const tops = new WeakMap<Element, number>();
    const range = (el: Element) => el.querySelectorAll("p").length * 40 - 100;
    const scroller = () => document.querySelector('[data-testid="s"]') as HTMLElement;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      return this.querySelectorAll("p").length * 40;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      v: number,
    ) {
      tops.set(this, Math.min(0, Math.max(v, -range(this))));
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const s = scroller();
      const contentTop = -(range(s) + (tops.get(s) ?? 0));
      const rect = (top: number, height: number) =>
        ({ top, bottom: top + height, height, left: 0, right: 0, width: 0 }) as DOMRect;
      if (this === s) return rect(0, 100);
      if (this === s.firstElementChild) return rect(contentTop, range(s) + 100);
      const i = [...s.querySelectorAll("p")].indexOf(this as HTMLParagraphElement);
      return i < 0 ? rect(0, 0) : rect(contentTop + i * 40, 40);
    });
  }
  function Thread({ before, n }: { before: number; n: number }) {
    const ref = useFollowBottom<HTMLDivElement>();
    return (
      <div ref={ref} data-testid="s" style={{ display: "flex", flexDirection: "column-reverse" }}>
        <div>
          {Array.from({ length: before + n }, (_, i) => i - before).map((id) => (
            // the items prepended above keep the others' keys
            <p key={id}>m {id}</p>
          ))}
        </div>
      </div>
    );
  }
  const scrollTo = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };
  const tick = () => new Promise((res) => setTimeout(res, 0));

  it("history prepended above leaves the view where it was", async () => {
    mockMeasuredLayout();
    vi.stubGlobal("CSS", { supports: () => false });
    const r = render(<Thread before={0} n={10} />);
    const el = r.getByTestId("s");
    scrollTo(el, -280); // 20 px from the top: m 0 half visible
    r.rerender(<Thread before={5} n={10} />); // 200 px more above
    await tick();
    // a reversed scroller keeps the distance from the bottom: m 0 stays where it was
    expect(el.scrollTop).toBe(-280);
    vi.unstubAllGlobals();
  });

  it("content arriving below still leaves the view where it was", async () => {
    mockMeasuredLayout();
    vi.stubGlobal("CSS", { supports: () => false });
    const r = render(<Thread before={0} n={10} />);
    const el = r.getByTestId("s");
    scrollTo(el, -200);
    r.rerender(<Thread before={0} n={12} />);
    await vi.waitFor(() => expect(el.scrollTop).toBe(-280));
    vi.unstubAllGlobals();
  });
});

describe("useFollowBottom attaches again when the scroller is replaced", () => {
  it("the new conversation's center layout giving way to the thread still follows", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      v: number,
    ) {
      tops.set(this, Math.min(v, 900));
    });
    const page = (fresh: boolean) => (
      <DesignProvider locale="en">
        <ConversationPage
          titleBar={titleBar}
          {...(fresh ? { newConversation: { agentName: "a" } } : {})}
          thread={<p>hi</p>}
          composer={<div>c</div>}
          status={{ context: "", version: "" }}
          right="none"
          onCloseRight={() => {}}
        />
      </DesignProvider>
    );
    const r = render(page(true));
    expect(document.querySelector(".cb-conv-scroll")?.getAttribute("data-center")).toBe("true");
    r.rerender(page(false));
    const scroll = document.querySelector(".cb-conv-scroll") as HTMLElement;
    expect(scroll.getAttribute("data-center")).toBeNull();
    // jsdom applies no stylesheet, so the scroller is not reversed here: attaching scrolls it
    // to the bottom, which proves the hook ran on the new element.
    await vi.waitFor(() => expect(scroll.scrollTop).toBe(900));
  });
});
