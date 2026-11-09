/**
 * A touch device (spec §4.3): the primary pointer is coarse, or a coarse pointer and no fine one. Read at the
 * moment of a choice (never in render), so a page can skip moving focus into a text field there:
 * on a phone that focus pops the keyboard for a tap that only switched something (an agent, a
 * quick action). False without `matchMedia` (the server, old test environments).
 */
export function isTouchPointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const mq = (q: string) => window.matchMedia(q).matches;
  return mq("(pointer: coarse)") || (mq("(any-pointer: coarse)") && !mq("(any-pointer: fine)"));
}

/**
 * The on-screen keyboard's height over the bottom of `bottom` (a layout-viewport edge, the
 * shell's bottom): what of it the visual viewport no longer shows, never below 0 (spec §4.3).
 */
export function keyboardInset(vv: { height: number; offsetTop: number }, bottom: number): number {
  return Math.max(0, Math.round(bottom - vv.height - vv.offsetTop));
}
