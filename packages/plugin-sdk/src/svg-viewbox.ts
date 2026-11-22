// Internal to the SDK: not re-exported from index.ts, so not part of the public API.

/** Characters of a viewBox value; longer values are refused before any regex sees them. */
export const VIEWBOX_MAX_CHARS = 128;
/**
 * The only regexes the viewBox parser runs. Each is one character class under one quantifier,
 * so matching is linear in the (already capped) input: there is nothing to backtrack into.
 */
export const VIEWBOX_SEPARATOR_RE = /[\s,]+/;
export const VIEWBOX_NUMBER_RE = /^[-+.0-9eE]+$/;

/** `min-x min-y width height`, width and height > 0; undefined when malformed. */
export function parseViewBox(v: string): [number, number, number, number] | undefined {
  if (v.length > VIEWBOX_MAX_CHARS) return undefined;
  const parts = v
    .trim()
    .split(VIEWBOX_SEPARATOR_RE)
    .filter((p) => p !== "");
  if (parts.length !== 4 || !parts.every((p) => VIEWBOX_NUMBER_RE.test(p))) return undefined;
  const n = parts.map(Number) as [number, number, number, number];
  if (!n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) return undefined;
  return n;
}
