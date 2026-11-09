/**
 * Focuses `get()` now or, when it cannot take focus yet, as soon as it can: a pending composer
 * frame (client extensions spec §6.3) hides the composer with `visibility: hidden` for up to
 * 1.5 s, and `focus()` on a hidden element does nothing. Tries again on each animation frame (the
 * getter is read each time, so a winner's composer that replaced the built-in is the one focused)
 * for at most `maxMs`; gives up as soon as focus has moved elsewhere (never steals it back).
 * Returns a cancel function.
 */
export function focusWhenPossible(get: () => HTMLElement | null, maxMs = 2000): () => void {
  const taken = () => {
    const el = get();
    el?.focus();
    return el !== null && document.activeElement === el;
  };
  if (taken() || typeof requestAnimationFrame === "undefined") return () => {};
  const until = performance.now() + maxMs;
  let frame = 0;
  const tick = () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (taken() || performance.now() >= until) return;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
