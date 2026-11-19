import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps a short thread at the top, centered on the composer's column", () => {
    const rule = decls('.cb-conv-scroll:not([data-center="true"]) > .cb-conv-thread');
    expect(rule).toMatch(/margin:\s*0 0 auto/);
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/margin-inline-start:[^;]*100cqw/);
    expect(decls(".cb-conv-center")).toMatch(/container-type:\s*inline-size/);
  });

  it("reserves the scrollbar gutter on the end side only (WebKit misplaces both-edges)", () => {
    expect(decls('.cb-conv-scroll:not([data-center="true"])')).toMatch(
      /scrollbar-gutter:\s*stable;/,
    );
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

/** A ResizeObserver whose callbacks the test fires by hand (jsdom has none): one entry per target. */
function stubResizeObserver() {
  const live = new Set<RO>();
  class RO {
    readonly targets = new Set<Element>();
    constructor(private readonly cb: (entries: { target: Element }[]) => void) {
      live.add(this);
    }
    observe(t: Element) {
      this.targets.add(t);
    }
    unobserve(t: Element) {
      this.targets.delete(t);
    }
    disconnect() {
      live.delete(this);
    }
    fire() {
      this.cb([...this.targets].map((target) => ({ target })));
    }
  }
  vi.stubGlobal("ResizeObserver", RO);
  return () => {
    for (const o of [...live]) o.fire();
  };
}

/** scrollHeight 400; clientHeight is mutable (the keyboard). Not reversed: jsdom has no CSS. */
function mockPlainLayout(view: { h: number }) {
  const tops = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(400);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => view.h);
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return tops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    v: number,
  ) {
    tops.set(this, Math.max(0, Math.min(v, this.scrollHeight - view.h)));
  });
}

describe("a resize is not a scroll (the keyboard opening, a sheet closing)", () => {
  function Plain({ n, onUnseen }: { n: number; onUnseen?: (u: boolean) => void }) {
    const ref = useFollowBottom<HTMLDivElement>(onUnseen);
    return (
      <div ref={ref} data-testid="s">
        <div>
          {Array.from({ length: n }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static case
            <p key={i}>m {i}</p>
          ))}
        </div>
      </div>
    );
  }

  it("at the bottom, shrinking the scroller by 300 px keeps it at the bottom", () => {
    const view = { h: 500 };
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => view.h);
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
      this: Element,
      v: number,
    ) {
      tops.set(this, Math.max(0, Math.min(v, 1000 - view.h)));
    });
    const fire = stubResizeObserver();
    const r = render(<Plain n={3} />);
    const el = r.getByTestId("s");
    expect(el.scrollTop).toBe(500);
    view.h = 200;
    fire();
    expect(el.scrollTop).toBe(800);
    view.h = 500;
    fire();
    expect(el.scrollTop).toBe(500);
  });

  it("away from the bottom a resize neither follows nor raises the latest signal", () => {
    const view = { h: 100 };
    mockPlainLayout(view);
    const fire = stubResizeObserver();
    const onUnseen = vi.fn();
    const r = render(<Plain n={3} onUnseen={onUnseen} />);
    const el = r.getByTestId("s");
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    view.h = 50;
    fire();
    expect(el.scrollTop).toBe(100);
    expect(onUnseen).not.toHaveBeenCalledWith(true);
  });

  it("away from the bottom, new content raises the latest signal; scrolling back clears it", async () => {
    const view = { h: 100 };
    mockPlainLayout(view);
    let height = 400;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => height);
    const onUnseen = vi.fn();
    const r = render(<Plain n={3} onUnseen={onUnseen} />);
    const el = r.getByTestId("s");
    el.scrollTop = 50;
    el.dispatchEvent(new Event("scroll"));
    height = 480;
    r.rerender(<Plain n={4} onUnseen={onUnseen} />);
    await vi.waitFor(() => expect(onUnseen).toHaveBeenLastCalledWith(true));
    el.scrollTop = 380;
    el.dispatchEvent(new Event("scroll"));
    expect(onUnseen).toHaveBeenLastCalledWith(false);
  });

  it("thread items get content-visibility auto and their measured height after the first measure", async () => {
    mockPlainLayout({ h: 100 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 120,
      width: 300,
      top: 0,
      bottom: 120,
      left: 0,
      right: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const fire = stubResizeObserver();
    const r = render(<Plain n={2} />);
    const items = [...r.getByTestId("s").querySelectorAll("p")] as HTMLElement[];
    // not before the first measure: a first paint is never skipped
    expect(items[0]?.style.contentVisibility ?? "").toBe("");
    fire();
    for (const p of items) {
      expect(p.getAttribute("style")).toMatch(/content-visibility:\s*auto/);
      expect(p.getAttribute("style")).toMatch(/contain-intrinsic-size:\s*auto 120px/);
    }
  });
});

describe("ConversationPage latest button", () => {
  const props = (thread: React.ReactNode) => (
    <DesignProvider locale="en">
      <ConversationPage
        titleBar={titleBar}
        thread={thread}
        composer={<div>c</div>}
        status={{ context: "", version: "" }}
        right="none"
        onCloseRight={() => {}}
      />
    </DesignProvider>
  );

  it("appears when new content arrives away from the bottom; one tap scrolls down and hides it", async () => {
    const view = { h: 100 };
    mockPlainLayout(view);
    let height = 400;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => height);
    const r = render(props(<p>one</p>));
    const scroll = document.querySelector(".cb-conv-scroll") as HTMLElement;
    expect(screen.queryByRole("button", { name: "Latest" })).toBeNull();
    scroll.scrollTop = 50;
    fireEvent.scroll(scroll);
    height = 500;
    r.rerender(props([<p key="a">one</p>, <p key="b">two</p>]));
    const button = await screen.findByRole("button", { name: "Latest" });
    act(() => button.click());
    expect(scroll.scrollTop).toBe(400);
    fireEvent.scroll(scroll);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Latest" })).toBeNull());
  });
});
