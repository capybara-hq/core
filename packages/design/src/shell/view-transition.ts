/**
 * Runs `update` inside a CSS view transition when the browser has them and the person has not
 * asked for reduced motion; otherwise it runs at once (an instant swap). Only the way back uses it
 * (`direction` "pop" slides back); a push slides in by a CSS animation (design spec §4.6).
 * `skip: true` swaps at once too: the browser already animated this move (a back gesture,
 * `PopStateEvent.hasUAVisualTransition`), so it never animates twice (mobile app spec §7.2).
 */
export function withViewTransition(
  update: () => void | Promise<void>,
  direction: "pop",
  options: { skip: boolean } = { skip: false },
): void {
  const doc = typeof document === "undefined" ? null : document;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (doc === null || options.skip || reduced || typeof doc.startViewTransition !== "function") {
    update();
    return;
  }
  const root = doc.documentElement;
  root.dataset.cbTransition = direction;
  const transition = doc.startViewTransition(() => update());
  const done = () => {
    delete root.dataset.cbTransition;
  };
  transition.finished.then(done, done);
}
