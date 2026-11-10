// @vitest-environment jsdom
// A focus request the composer cannot take yet (a pending composer frame hides it with
// `visibility: hidden`, where `focus()` is a no-op) is kept until the composer can take it: the
// frame's reveal or the winner's composer (final review, Task 18 r2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusWhenPossible } from "../src/lib/deferred-focus";

/** A textarea that takes focus only once `ready` (as a hidden one does not). */
function gated() {
  const el = document.createElement("textarea");
  document.body.append(el);
  const state = { ready: false };
  const real = el.focus.bind(el);
  el.focus = () => {
    if (state.ready) real();
  };
  return { el, state };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("focusWhenPossible", () => {
  it("focuses at once when it can", () => {
    const el = document.createElement("textarea");
    document.body.append(el);
    focusWhenPossible(() => el);
    expect(document.activeElement).toBe(el);
  });

  it("retries until the element can take focus (the reveal)", () => {
    const { el, state } = gated();
    focusWhenPossible(() => el);
    expect(document.activeElement).not.toBe(el);
    vi.advanceTimersByTime(500);
    expect(document.activeElement).not.toBe(el);
    state.ready = true;
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(el);
  });

  it("follows the element the getter gives (the winner's composer replaces the built-in)", () => {
    const first = gated();
    let current = first.el;
    focusWhenPossible(() => current);
    const second = document.createElement("textarea");
    document.body.append(second);
    current = second;
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(second);
  });

  it("gives up when focus moved elsewhere meanwhile, or after the limit", () => {
    const { el, state } = gated();
    focusWhenPossible(() => el);
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    state.ready = true;
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(other);
    other.blur();
    const late = gated();
    focusWhenPossible(() => late.el, 1000);
    vi.advanceTimersByTime(1500);
    late.state.ready = true;
    vi.advanceTimersByTime(100);
    expect(document.activeElement).not.toBe(late.el);
  });

  it("can be cancelled", () => {
    const { el, state } = gated();
    const cancel = focusWhenPossible(() => el);
    cancel();
    state.ready = true;
    vi.advanceTimersByTime(100);
    expect(document.activeElement).not.toBe(el);
  });
});
