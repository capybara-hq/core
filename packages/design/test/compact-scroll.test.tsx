// The compact one scroller (responsive system spec §2.6, D7; design spec §6.65): the scrolled
// title (`titleAway`) and the quick-return bar (`barHidden`), read from one passive scroll listener
// at most once per frame, compact only.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompactScroll } from "../src/index";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

/** Runs the frames requested so far. */
function flushFrames() {
  const due = frames;
  frames = [];
  act(() => {
    for (const cb of due) cb(0);
  });
}

/**
 * A scroller 600 px high whose content is `content` px high, with a title whose bottom sits 120 px
 * below the content's top and a quick-return bar after it that sticks at the scroller's top once
 * scrolled past (its offsetTop and rectangle follow `scrollTop` then); the rectangles follow
 * `scrollTop`.
 */
function page(content = 2000) {
  const scroller = document.createElement("div");
  const title = document.createElement("h1");
  const bar = document.createElement("div");
  scroller.append(title, bar);
  document.body.append(scroller);
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
  // sticky: once stuck, the bar's offset moves with the scroll
  Object.defineProperty(bar, "offsetTop", { configurable: true, get: () => Math.max(130, top) });
  bar.getBoundingClientRect = () => ({ top: Math.max(130 - top, 0) }) as DOMRect;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  title.getBoundingClientRect = () => ({ top: 80 - top, bottom: 120 - top }) as DOMRect;
  /** A person's scroll (a wheel first); `programmatic`: a scroll with no gesture (a restore). */
  const scrollTo = (v: number, programmatic = false) => {
    if (!programmatic) scroller.dispatchEvent(new Event("wheel"));
    top = v;
    scroller.dispatchEvent(new Event("scroll"));
  };
  return { scroller, els: { scroller, title, bar }, scrollTo };
}

let seen: { titleAway: boolean; barHidden: boolean } = { titleAway: false, barHidden: false };
function Probe(props: {
  scroller: HTMLElement | null;
  title: HTMLElement | null;
  bar?: HTMLElement | null;
}) {
  seen = useCompactScroll(props.scroller, props.title, props.bar);
  return null;
}

describe("useCompactScroll", () => {
  it("useCompactScroll reports titleAway past the title", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    const listen = vi.spyOn(p.scroller, "addEventListener");
    render(<Probe {...p.els} />);
    expect(seen.titleAway).toBe(false);
    expect(listen).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });

    p.scrollTo(60);
    flushFrames();
    expect(seen.titleAway).toBe(false);
    p.scrollTo(130);
    flushFrames();
    expect(seen.titleAway).toBe(true);
    p.scrollTo(10);
    flushFrames();
    expect(seen.titleAway).toBe(false);
  });

  it("titleAway counts the floating row (--cb-float-row on the scroller)", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    p.scroller.style.setProperty("--cb-float-row", "56px");
    render(<Probe {...p.els} />);
    p.scrollTo(60);
    flushFrames();
    expect(seen.titleAway).toBe(false);
    // the title's bottom (120 - 64 = 56) reaches the row's bottom edge
    p.scrollTo(64);
    flushFrames();
    expect(seen.titleAway).toBe(true);
  });

  it("a calc() floating row is resolved by a probe", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    p.scroller.style.setProperty("--cb-float-row", "calc(8px + 48px)");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { height: this.style.height.includes("--cb-float-row") ? 56 : 0 } as DOMRect;
    });
    render(<Probe {...p.els} />);
    p.scrollTo(64);
    flushFrames();
    expect(seen.titleAway).toBe(true);
    expect(p.scroller.children).toHaveLength(2);
  });

  it("reads the scroll once per frame", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    p.scrollTo(50);
    p.scrollTo(100);
    p.scrollTo(150);
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(seen.titleAway).toBe(true);
    p.scrollTo(160);
    expect(frames).toHaveLength(1);
  });

  it("barHidden on scroll down, shown on scroll up", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    // above the title's bottom a scroll down keeps it
    p.scrollTo(40);
    flushFrames();
    expect(seen.barHidden).toBe(false);
    p.scrollTo(300);
    flushFrames();
    expect(seen.barHidden).toBe(true);
    p.scrollTo(290);
    flushFrames();
    expect(seen.barHidden).toBe(false);
    p.scrollTo(400);
    flushFrames();
    expect(seen.barHidden).toBe(true);
  });

  it("a stuck sticky bar still hides on scroll down", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    p.scrollTo(500);
    flushFrames();
    p.scrollTo(450);
    flushFrames();
    expect(seen.barHidden).toBe(false);
    // stuck: its offsetTop is 450 now and follows the scroll
    p.scrollTo(470);
    flushFrames();
    expect(seen.barHidden).toBe(true);
  });

  it("an overscroll bounce past the end does not bring the bar back", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    p.scrollTo(1400);
    flushFrames();
    expect(seen.barHidden).toBe(true);
    // a rubber band past the end (max 1400) settles back to the end
    p.scrollTo(1460);
    flushFrames();
    p.scrollTo(1400);
    flushFrames();
    expect(seen.barHidden).toBe(true);
  });

  it("without a bar nothing is hidden", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe scroller={p.els.scroller} title={p.els.title} />);
    p.scrollTo(500);
    flushFrames();
    expect(seen.barHidden).toBe(false);
    expect(seen.titleAway).toBe(true);
  });

  it("short content never hides the bar", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page(600);
    render(<Probe {...p.els} />);
    // an elastic overscroll on content that fits still fires scroll events
    p.scrollTo(120);
    flushFrames();
    expect(seen.barHidden).toBe(false);
  });

  it("titleAway follows restored scroll", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    // back from a detail: the list's scroller is already at its old position when the page mounts
    p.scroller.scrollTop = 900;
    render(<Probe {...p.els} />);
    // read before paint (a layout effect), with no frame in between
    expect(frames).toHaveLength(0);
    expect(seen.titleAway).toBe(true);
    // a restore lands on the bar shown: only a scroll down hides it
    expect(seen.barHidden).toBe(false);
    p.scrollTo(950);
    flushFrames();
    expect(seen.barHidden).toBe(true);
  });

  it("a programmatic restore after mount keeps the bar shown", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    p.scrollTo(900, true);
    flushFrames();
    expect(seen).toEqual({ titleAway: true, barHidden: false });
    p.scrollTo(950);
    flushFrames();
    expect(seen.barHidden).toBe(true);
  });

  it("a scroller that mounts later or is replaced is watched, the old one let go", () => {
    window.matchMedia = matchMediaFor(390).matchMedia;
    const { rerender } = render(<Probe scroller={null} title={null} bar={null} />);
    const p = page();
    p.scroller.scrollTop = 900;
    rerender(<Probe {...p.els} />);
    expect(seen.titleAway).toBe(true);
    const q = page();
    rerender(<Probe {...q.els} />);
    expect(seen.titleAway).toBe(false);
    p.scrollTo(1000);
    expect(frames).toHaveLength(0);
    q.scrollTo(300);
    flushFrames();
    expect(seen).toEqual({ titleAway: true, barHidden: true });
  });

  it("no-op at 768", () => {
    window.matchMedia = matchMediaFor(768).matchMedia;
    const p = page();
    p.scroller.scrollTop = 900;
    const listen = vi.spyOn(p.scroller, "addEventListener");
    render(<Probe {...p.els} />);
    p.scrollTo(1000);
    expect(frames).toHaveLength(0);
    expect(listen).not.toHaveBeenCalled();
    expect(seen).toEqual({ titleAway: false, barHidden: false });
  });

  it("leaving compact resets both", () => {
    const mm = matchMediaFor(390);
    window.matchMedia = mm.matchMedia;
    const p = page();
    render(<Probe {...p.els} />);
    p.scrollTo(500);
    flushFrames();
    expect(seen).toEqual({ titleAway: true, barHidden: true });
    act(() => mm.resize(768));
    expect(seen).toEqual({ titleAway: false, barHidden: false });
  });
});
