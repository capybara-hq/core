import { useCallback, useState } from "react";
import { useBrand } from "../provider";

/**
 * A theme-supplied URL as a CSS `url()` value: the one way a brand URL reaches CSS (theme brand
 * coverage spec §3). The URL goes inside a double-quoted CSS string; every character that could
 * end or bend that string (`"`, `\`, a newline, any C0 control character and DEL) is written as a
 * hex escape followed by one space (`\22 `, `\5c `, `\a `), so the string always ends at our
 * closing quote and a parser reads back exactly the input (CSS Syntax 3 §4.3.7; NUL, which no CSS
 * string can hold, reads back as U+FFFD). `)` and `;` need no escape inside a quoted string. A
 * lone surrogate becomes U+FFFD, so the server render and the browser serialize the same string.
 */
export function cssUrlValue(url: string): string {
  let escaped = "";
  for (const c of url) {
    const code = c.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      escaped += "\uFFFD";
      continue;
    }
    escaped +=
      c === '"' || c === "\\" || code < 0x20 || code === 0x7f ? `\\${code.toString(16)} ` : c;
  }
  return `url("${escaped}")`;
}

/** The inline style that hands a brand graphic to the design CSS: only `--cb-brand-art`. */
export function brandArtStyle(url: string): { "--cb-brand-art": string } {
  return { "--cb-brand-art": cssUrlValue(url) };
}

/** The theme's mark and its load state, as `useBrandMark` returns it. */
export type BrandMark = {
  src: string;
  /** Whether this `src` failed to load in this mount: draw the built-in graphic instead. */
  failed: boolean;
  /** The image's `error` handler. */
  onError(): void;
  /**
   * The image's ref: catches an image that already failed before React hydrated it (a server
   * rendered img whose `error` event fired before its listener existed). A complete image with
   * no width is broken, unless `decode()` resolves (an SVG without an intrinsic size).
   */
  ref(img: HTMLImageElement | null): void;
};

/**
 * The theme's mark for a component that draws it (`Logo`, `Greeting`, `WorkingLine`), null
 * without a brand or without a mark (an empty URL is none). Wire `onError` and `ref` to the img;
 * once `failed`, the component draws its built-in graphic. Failure is remembered per `src` for the
 * rest of this mount: a new `src` starts unfailed, and a `src` that already failed stays failed
 * when it comes back (A, B, back to A). A new mount tries every `src` again.
 */
export function useBrandMark(): BrandMark | null {
  const src = useBrand()?.markUrl || null;
  const [failedSrcs, setFailedSrcs] = useState<readonly string[]>([]);
  const onError = useCallback(() => {
    if (src !== null) setFailedSrcs((prev) => (prev.includes(src) ? prev : [...prev, src]));
  }, [src]);
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img?.complete || img.naturalWidth > 0) return;
      if (typeof img.decode !== "function") {
        onError();
        return;
      }
      img.decode().then(
        () => {},
        () => {
          // only if the img still shows this src (a src change re-runs this ref)
          if (img.getAttribute("src") === src) onError();
        },
      );
    },
    [src, onError],
  );
  if (src === null) return null;
  return { src, failed: failedSrcs.includes(src), onError, ref };
}
