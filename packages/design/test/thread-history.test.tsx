import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationPage,
  DesignProvider,
  ThreadHistory,
  type ThreadHistoryState,
} from "../src/index";

/** The thread's top edge while its history loads in pages (spec §5.4 "Thread scrolling"). */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const edge = (state: ThreadHistoryState, onLoadEarlier = vi.fn()) =>
  render(
    <DesignProvider locale="en">
      <ThreadHistory state={state} onLoadEarlier={onLoadEarlier} />
    </DesignProvider>,
  );

/** An IntersectionObserver whose instances the test drives. */
function fakeObserver() {
  const made: {
    cb: IntersectionObserverCallback;
    init?: IntersectionObserverInit;
    off: boolean;
  }[] = [];
  class IO {
    rec: (typeof made)[number];
    constructor(cb: IntersectionObserverCallback, init?: IntersectionObserverInit) {
      this.rec = { cb, ...(init ? { init } : {}), off: false };
      made.push(this.rec);
    }
    observe() {}
    disconnect() {
      this.rec.off = true;
    }
  }
  vi.stubGlobal("IntersectionObserver", IO);
  const show = (i: number, isIntersecting = true) =>
    made[i]?.cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  return { made, show };
}

describe("ThreadHistory", () => {
  it("more: a link reads the previous page", () => {
    const load = vi.fn();
    edge("more", load);
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("more: the observed edge reads it on its own once it comes within 600 px of the view", () => {
    const io = fakeObserver();
    const load = vi.fn();
    const r = edge("more", load);
    expect(io.made).toHaveLength(1);
    expect(io.made[0]?.init?.rootMargin).toBe("600px 0px 0px 0px");
    io.show(0, false);
    expect(load).not.toHaveBeenCalled();
    io.show(0);
    expect(load).toHaveBeenCalledTimes(1);
    // each state change makes the observer again: a page that leaves the edge in range reads on
    r.rerender(
      <DesignProvider locale="en">
        <ThreadHistory state="loading" onLoadEarlier={load} />
      </DesignProvider>,
    );
    expect(io.made[0]?.off).toBe(true);
    r.rerender(
      <DesignProvider locale="en">
        <ThreadHistory state="more" onLoadEarlier={load} />
      </DesignProvider>,
    );
    expect(io.made).toHaveLength(2);
  });

  it("loading: a placeholder turn and a polite status, nothing observed", () => {
    const io = fakeObserver();
    const r = edge("loading");
    const el = r.container.querySelector('[data-part="thread-history"]');
    expect(el?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading earlier messages");
    expect(io.made).toHaveLength(0);
  });

  it("failed: an alert with Retry", () => {
    const load = vi.fn();
    edge("failed", load);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load earlier messages");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("start: the beginning of the conversation, no control", () => {
    edge("start");
    expect(screen.getByText("Beginning of conversation")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ConversationPage history", () => {
  const titleBar = {
    title: "t",
    untitled: "u",
    menu: [],
    properties: { pressed: false, onToggle: () => {} },
    panels: [],
  };
  const page = (history?: { state: ThreadHistoryState; onLoadEarlier(): void }) => (
    <DesignProvider locale="en">
      <ConversationPage
        titleBar={titleBar}
        thread={<p>first</p>}
        {...(history ? { history } : {})}
        composer={<div>c</div>}
        status={{ context: "", version: "" }}
        right="none"
        onCloseRight={() => {}}
      />
    </DesignProvider>
  );

  it("draws the edge above the thread, inside the thread's wrapper", async () => {
    const r = render(page({ state: "start", onLoadEarlier: () => {} }));
    await act(async () => {});
    const thread = r.container.querySelector('[data-part="thread"]') as HTMLElement;
    expect(thread.firstElementChild?.getAttribute("data-part")).toBe("thread-history");
    expect(thread.textContent).toMatch(/^Beginning of conversation.*first/);
  });

  it("draws none without history", () => {
    const r = render(page());
    expect(r.container.querySelector('[data-part="thread-history"]')).toBeNull();
  });
});
