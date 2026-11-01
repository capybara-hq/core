"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "../../i18n/navigation";
import { useSetup } from "./setup";

/**
 * Drawn by a page whose server read found the org not ready (or no current org) while the frame
 * may still draw the ready shell: a client navigation reuses the layout's props, so after an admin
 * removed the last model the shell would stay with an empty page inside. Outside the setup frame it
 * re-renders the route once (`router.refresh()`), which re-reads the layout; inside it, nothing.
 */
export function RefreshShell() {
  const router = useRouter();
  const { active } = useSetup();
  const done = useRef(false);
  useEffect(() => {
    if (active || done.current) return;
    done.current = true;
    // ssr-exempt: the layout's props are stale; nothing of the page paints, the frame re-reads
    router.refresh();
  }, [active, router]);
  return null;
}
