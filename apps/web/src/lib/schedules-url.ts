"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "../i18n/navigation";
import { cookieOf } from "./cookies";
import {
  parseRunPanelRef,
  type RunPanelRef,
  refId,
  SCHEDULES_VIEW_COOKIE,
  type SchedulesUrl,
  schedulesSearch,
  schedulesUrlOf,
  viewCookie,
} from "./schedule-calendar";

/**
 * The state of `/schedules` (list or calendar, range, date, scope; calendar spec §4.1): held in
 * state for an instant switch and written to the address with `history.replaceState` (Next keeps
 * its router's search params in step, as `useUrlParam` does), so a reload, Back and a shared link
 * show the same view. The tab and the range are also written to the `cap_schedules_view` cookie,
 * which the server reads for the next document's first paint. `initial` is what `page.tsx` read
 * from the address and the cookie; when it changes (a navigation to `/schedules` with other
 * parameters) the state follows it, and so it does when the address changes by anything but this
 * hook's own writes (Back and Forward restoring an entry, as `useUrlParam` follows them).
 */
export function useSchedulesUrl(
  initial: SchedulesUrl,
): [SchedulesUrl, (next: SchedulesUrl) => void] {
  const [value, setValue] = useState(initial);
  const key = schedulesSearch(initial) + initial.view + initial.range;
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setValue(initial);
  }
  const params = useSearchParams();
  const address = ["view", "range", "date", "scope"].map((n) => params.get(n) ?? "").join("|");
  const [seenAddress, setSeenAddress] = useState(address);
  // The address this hook wrote last: its own writes are already the state.
  const written = useRef<string | null>(null);
  if (seenAddress !== address) {
    setSeenAddress(address);
    if (written.current !== address) {
      // A change from outside (only after hydration: the server never sees one), read with the
      // remembered view as page.tsx reads it.
      setValue(schedulesUrlOf(params, cookieOf(document.cookie, SCHEDULES_VIEW_COOKIE)));
    }
  }
  // The tab and range shown are remembered (an explicit `?view=` too: it wins and is written back).
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and not everywhere
    document.cookie = viewCookie(value.view, value.range);
  }, [value.view, value.range]);
  const select = (next: SchedulesUrl) => {
    setValue(next);
    // In an event handler, never during render (web-ssr-location). The run panel's hash belongs
    // to the calendar: the list drops it.
    const url = new URL(window.location.href);
    const hash = next.view === "calendar" ? url.hash : "";
    const search = schedulesSearch(next);
    const q = new URLSearchParams(search);
    written.current = ["view", "range", "date", "scope"].map((n) => q.get(n) ?? "").join("|");
    window.history.replaceState(window.history.state, "", url.pathname + search + hash);
  };
  return [value, select];
}

/**
 * The run panel's item in the address hash (`#run=…`, `#at=…`, `#day=…`; calendar spec §4.5), so a
 * reload keeps it. Read after mount (the server render has no hash) and on `hashchange`; written
 * with `history.replaceState`.
 */
export function useRunPanelHash(): [RunPanelRef | null, (next: RunPanelRef | null) => void] {
  const [ref, setRef] = useState<RunPanelRef | null>(null);
  useEffect(() => {
    const read = () => setRef(parseRunPanelRef(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const select = (next: RunPanelRef | null) => {
    setRef(next);
    const url = new URL(window.location.href);
    const hash = next === null ? "" : `#${refId(next)}`;
    window.history.replaceState(window.history.state, "", url.pathname + url.search + hash);
  };
  return [ref, select];
}
