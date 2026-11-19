/**
 * The window sizes of the visual matrix (mobile layout spec §11.1): one per size class plus the
 * two real-device Duo widths. Heights follow the simulator's reported sizes for the Duo samples,
 * 844 for 390, 1024 for 768 and 900 for 1440.
 *
 * The Duo heights are provisional until the Xcode 27.1 simulator's reported sizes are recorded
 * here (Safari 27.1 reports heights 368-902 CSS px, spec §14): the outer display in portrait
 * takes the 390 phone's 844, the inner display in landscape the lower end of that range's
 * landscape use, 640.
 */
export const SIZE_MATRIX = [
  { width: 382, height: 844, why: "iPhone Duo outer display, portrait" },
  { width: 390, height: 844, why: "the existing phone width" },
  { width: 768, height: 1024, why: "medium: a tablet in portrait" },
  {
    width: 951,
    height: 640,
    why: "iPhone Duo inner display, landscape (expanded at its smallest)",
  },
  { width: 1440, height: 900, why: "the existing desktop width" },
] as const;

export const MATRIX_WIDTHS = SIZE_MATRIX.map((s) => s.width);

/** The window height the matrix uses for `width` (900 for any other width, as before). */
export const heightFor = (width: number): number =>
  SIZE_MATRIX.find((s) => s.width === width)?.height ?? 900;

/** The short-window form (spec §3.2): a phone in landscape, one baseline per template page. */
export const SHORT_WINDOW = { width: 844, height: 390 } as const;
