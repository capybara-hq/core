// The focus an overlay moves on open draws a ring only after a key (spec §2.5 "A ring never follows a
// mouse click"). Chromium gives a script's focus `:focus-visible` whenever its own heuristics say
// so (no pointer press seen yet, a window that was not focused, a native shell calling in), so the
// drawer's search pill and a bottom sheet's close button could open ringed after a click or a tap.
// The element is marked `data-quiet-focus` until a key is pressed (a modifier alone does not count)
// or it loses focus; the stylesheet draws no ring and no ground on a marked element.

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);

/** Whether the last input before now was a key press (not a pointer press). */
let keyboardLast = false;
let listening = false;

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (!MODIFIERS.has(e.key)) keyboardLast = true;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      keyboardLast = false;
    },
    true,
  );
}
listen();

/**
 * Focuses `el` for an overlay that just opened: with the ring when the overlay was opened from the
 * keyboard, else quietly (no ring, no focus ground) until the next key press or blur.
 */
export function focusOnOpen(el: HTMLElement | null | undefined): void {
  if (!el) return;
  listen();
  if (keyboardLast) {
    el.focus();
    return;
  }
  el.setAttribute("data-quiet-focus", "true");
  const clear = (e?: KeyboardEvent) => {
    if (e && MODIFIERS.has(e.key)) return;
    el.removeAttribute("data-quiet-focus");
    document.removeEventListener("keydown", clear, true);
    el.removeEventListener("blur", onBlur);
  };
  const onBlur = () => clear();
  document.addEventListener("keydown", clear, true);
  el.addEventListener("blur", onBlur);
  el.focus();
}

/** The overlay's first focusable element (links, enabled buttons, tab stops). */
export const FIRST_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Whether the last input was a key press rather than a pointer press. */
export function lastInputWasKey(): boolean {
  listen();
  return keyboardLast;
}
