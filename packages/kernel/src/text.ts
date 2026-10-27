/**
 * Characters people-facing one-line labels (conversation titles, tool titles) never carry: format
 * characters (Unicode Cf: bidi marks, overrides and isolates U+061C, U+200E/F, U+202A–202E,
 * U+2066–2069; zero-width and invisible ones like U+200B, U+2060, U+FEFF; tag characters) except
 * ZWNJ (U+200C) and ZWJ (U+200D), which Persian and other scripts and emoji sequences need. The same
 * rule as the plugin SDK's `validateToolPresentation` and connector-mcp's title cleaning.
 *
 * Global: for `String.replace` only. Never call `.test()` / `.exec()` on it (a global regex keeps
 * `lastIndex` between calls); use {@link CONTROL_OR_HIDDEN_RE} to test.
 */
export const HIDDEN_FORMAT_RE = /(?![\u200C\u200D])\p{Cf}/gu;

/** {@link HIDDEN_FORMAT_RE} plus control characters (Cc, newlines included). */
export const CONTROL_OR_HIDDEN_RE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;
