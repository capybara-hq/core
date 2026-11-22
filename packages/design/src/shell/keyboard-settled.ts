/** Fired on `window` once the shell's `--cb-keyboard-inset` has stopped changing. */
export const KEYBOARD_INSET_SETTLED_EVENT = "cb-keyboard-inset-settled";

/** How long the inset must stay unchanged to count as settled (the keyboard's animation). */
export const INSET_SETTLE_MS = 120;
