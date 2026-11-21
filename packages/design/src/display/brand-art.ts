import { useCallback, useState } from "react";
import { useBrand } from "../provider";

/**
 * A theme-supplied URL as a CSS `url()` value: the one way a brand URL reaches CSS (theme brand
 * coverage spec §3). The URL goes inside a double-quoted CSS string; every character that could
 * end or bend that string (`"`, `\`, a newline, any C0 control character and DEL) is written as a
 * hex escape followed by one space (`\22 `, `\5c `, `\a `), so the string always ends at our
 * closing quote and a parser reads back exactly the input (CSS Syntax 3 §4.3.7; NUL, which no CSS
 * string can hold, reads back as U+FFFD). `)` and `;` need no escape inside a quoted string.
 */
export function cssUrlValue(url: string): string {
  let escaped = "";
  for (const c of url) {
    const code = c.codePointAt(0) as number;
    escaped +=
      c === '"' || c === "\\" || code < 0x20 || code === 0x7f ? `\\${code.toString(16)} ` : c;
  }
  return `url("${escaped}")`;
}

/** The inline style that hands a brand graphic to the design CSS: only `--cb-brand-art`. */
export function brandArtStyle(url: string): { "--cb-brand-art": string } {
  return { "--cb-brand-art": cssUrlValue(url) };
}

/**
 * The theme's mark for a component that draws it (`Logo`, `Greeting`, `WorkingLine`), null
 * without a brand or without a mark. `failed` turns true after `onError` (wire it to the image's
 * `error` event): the component then draws its built-in graphic for the rest of this mount. A new
 * `src` starts unfailed.
 */
export function useBrandMark(): { src: string; failed: boolean; onError(): void } | null {
  const src = useBrand()?.markUrl ?? null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const onError = useCallback(() => setFailedSrc(src), [src]);
  if (src === null) return null;
  return { src, failed: failedSrc === src, onError };
}
