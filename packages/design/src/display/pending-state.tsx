import { useEffect, useState } from "react";
import { useDesignT } from "../provider";

/** How long the neutral state stays empty before its quiet skeleton shows. */
export const PENDING_DELAY_MS = 300;

/**
 * The neutral loading state of a page whose outcome is not known yet (spec §6.20): nothing shaped
 * like one of the possible outcomes (no composer outline, no checklist, no sidebar), only the
 * background; after {@link PENDING_DELAY_MS} a few quiet bars in a centered column. `frame="app"`
 * fills the window (before the app frame knows which layout to draw); `page` fills the content
 * area.
 */
export function PendingState({
  frame = "page",
  delayMs = PENDING_DELAY_MS,
}: {
  frame?: "app" | "page";
  delayMs?: number;
}) {
  const t = useDesignT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return (
    <div
      className="cb-pending"
      data-part="pending-state"
      data-frame={frame}
      role="status"
      aria-busy="true"
    >
      <span className="cb-sr-only">{t("table.loading")}</span>
      {shown ? (
        <div className="cb-pending-column" aria-hidden="true">
          <span className="cb-pending-bar" data-part="pending-bar" data-line="title" />
          <span className="cb-pending-bar" data-part="pending-bar" data-line="text" />
          <span className="cb-pending-bar" data-part="pending-bar" data-line="short" />
        </div>
      ) : null}
    </div>
  );
}
