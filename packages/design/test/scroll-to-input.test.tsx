import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, Input, Textarea } from "../src/index";
import { matchMediaFor } from "./width";

// Scroll to input (mobile interaction model §5): a focused field inside a scroller is scrolled into
// view once the keyboard inset has settled; a design behaviour of Input / Textarea under the mobile
// query, not page code.

class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  set(height: number) {
    this.height = height;
    this.dispatchEvent(new Event("resize"));
  }
}

const sidebar = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "owner", menu: [] },
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};
const status = { context: "grant@acme:/", version: "0.1.0" };

const originalMatchMedia = window.matchMedia;
const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
let vv: FakeViewport;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView =
    scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
  if (original) Object.defineProperty(window, "visualViewport", original);
  else Reflect.deleteProperty(window, "visualViewport");
});

const renderAt = (width: number) => {
  window.matchMedia = matchMediaFor(width).matchMedia;
  return render(
    <DesignProvider locale="en">
      <AppShell sidebar={sidebar} status={status}>
        <div style={{ overflowY: "auto" }}>
          <Input aria-label="name" />
          <Textarea aria-label="notes" />
        </div>
      </AppShell>
    </DesignProvider>,
  );
};

describe("scroll to input", () => {
  it("focus inside a scroller scrolls the field into view after the inset changes", () => {
    const { getByLabelText } = renderAt(390);
    const field = getByLabelText("name");
    field.focus();
    fireEvent.focus(field);
    act(() => vv.set(500));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(field);
  });

  it("no call on a fine pointer at 1440", () => {
    const { getByLabelText } = renderAt(1440);
    const field = getByLabelText("notes");
    fireEvent.focus(field);
    act(() => vv.set(500));
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
