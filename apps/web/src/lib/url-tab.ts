"use client";

import { useState } from "react";
import { useSearchParams } from "../i18n/navigation";

/**
 * A page's view tab kept in the address (`?tab=<id>`, none for `none`): held in state for an
 * instant switch and written with `history.replaceState` (Next keeps its router's search params
 * in step), so a reload or a shared link opens the same tab. The state follows the address when it
 * changes by a navigation too: a link to the bare page (the sidebar's item) while another tab is
 * open goes back to `none`. `initial` is what the page's server props read; `parse` reads `?tab=`.
 */
export function useUrlTab<T extends string>(
  initial: T,
  parse: (raw: string | null) => T,
  none: T,
): [T, (t: T) => void] {
  const fromUrl = parse(useSearchParams().get("tab"));
  const [tab, setTab] = useState<T>(initial);
  // The address's tab last seen: a change of it (a navigation) wins over the state
  const [seen, setSeen] = useState<T>(fromUrl);
  if (seen !== fromUrl) {
    setSeen(fromUrl);
    setTab(fromUrl);
  }
  const select = (next: T) => {
    setTab(next);
    // In an event handler, never during render (web-ssr-location).
    const url = new URL(window.location.href);
    if (next === none) url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };
  return [tab, select];
}
