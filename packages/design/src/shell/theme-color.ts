import { useEffect } from "react";

/** A plain colour the browser chrome takes (hex or `rgb()` / `rgba()`). */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;

/** The theme stylesheets React hoists into `<head>` (the web's `ThemeLink`). */
const THEME_SHEET = 'link[rel="stylesheet"][data-precedence="theme"]';

/**
 * Keeps `<meta name="theme-color">` on the page's background (theme brand coverage spec §6): the
 * computed `--cb-bg` of `<html>`, the value `chrome@1` sends a native shell. After mount, on every
 * change of `<html>`'s `data-theme` (the scheme toggle), class or style, when a theme stylesheet
 * finishes loading, and when `themeKey` changes (a theme switch enables another loaded sheet). The
 * server writes the first value (`generateViewport`); a document without the meta is left alone.
 */
export function useThemeColorMeta(themeKey: string | null = null): void {
  useEffect(() => {
    void themeKey;
    const root = document.documentElement;
    const sync = () => {
      const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
      if (metas.length === 0) return;
      const bg = getComputedStyle(root).getPropertyValue("--cb-bg").trim();
      if (!COLOR.test(bg)) return;
      for (const meta of metas) if (meta.content !== bg) meta.content = bg;
    };
    sync();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(sync);
    observer?.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    // `load` does not bubble: listen in the capture phase for the theme sheets
    const onLoad = (e: Event) => {
      if (e.target instanceof Element && e.target.matches(THEME_SHEET)) sync();
    };
    document.addEventListener("load", onLoad, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("load", onLoad, true);
    };
  }, [themeKey]);
}
