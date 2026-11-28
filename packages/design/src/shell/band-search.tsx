import { type JSX, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

/** The room kept clear on each side of the field (CSS px). */
const CLEAR = 12;

/**
 * The search field in the centre of a desktop shell's ground band (layered shell spec §2, desktop
 * client spec §7.3, maintainer decision 2026-11-28): wherever the window's top row is a band of
 * ground (the start controls' band in the rail's form, the end controls' band), the band's centre
 * holds a field that opens the command palette, exactly what the sidebar's search button opens, so
 * the band never looks empty, and the sidebar's (or the rail's) button gives way to it. CSS decides
 * where the field may show (a band, not on a conversation, whose band row is full;
 * shell-environment.css); this component measures whether it fits there: it never overlaps the
 * band row's own content (a path or title, a path row, the panel toggles, the band's sidebar
 * toggle), the sidebar or the window controls, and while it would, it stays hidden
 * (`data-fits="false"`) and the sidebar's button comes back.
 */
export function BandSearch({ onOpen }: { onOpen(): void }): JSX.Element {
  const t = useDesignT();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const f = field.getBoundingClientRect();
      // display: none (no end band here) measures 0 wide
      if (f.width === 0) {
        setFits(false);
        return;
      }
      const left = f.left - CLEAR;
      const right = f.right + CLEAR;
      const root = getComputedStyle(document.documentElement);
      const cx = Number.parseFloat(root.getPropertyValue("--cb-shell-controls-x"));
      const cw = Number.parseFloat(root.getPropertyValue("--cb-shell-controls-width"));
      if (Number.isFinite(cx) && Number.isFinite(cw) && right > cx && left < cx + cw) {
        setFits(false);
        return;
      }
      const shell = field.closest(".cb-shell") ?? document;
      const items = shell.querySelectorAll(
        [
          ":scope > .cb-sidebar",
          ":scope > .cb-shell-rail-toggle",
          ".cb-shell-main .cb-title-bar > :not(.cb-drag-fill):not(.cb-title-plain)",
          ".cb-shell-main .cb-title-path-item",
          ".cb-shell-main .cb-pageheader-path > :not(.cb-drag-fill)",
          ".cb-shell-main .cb-pageheader-titleless > :not(.cb-drag-fill)",
        ].join(", "),
      );
      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // only what lies in the band's row (the field's own height)
        if (r.bottom <= f.top || r.top >= f.bottom) continue;
        if (r.right > left && r.left < right) {
          setFits(false);
          return;
        }
      }
      setFits(true);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    check();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(document.documentElement);
    // a page or title change, and the sidebar's form (collapsed, rail), which moves the band
    const shellEl = field.closest(".cb-shell");
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    if (shellEl)
      mo?.observe(shellEl, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-mode", "data-collapsed", "data-responsive", "data-new"],
      });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);
  const label = t("shell.search");
  return (
    <button
      ref={ref}
      type="button"
      className="cb-band-search"
      data-part="band-search"
      data-fits={fits ? "true" : "false"}
      aria-label={label}
      aria-keyshortcuts="Control+K Meta+K"
      title={label}
      onClick={onOpen}
    >
      <Icon name="search" size={14} />
      <span className="cb-band-search-text">{t("shell.searchShort")}</span>
    </button>
  );
}
