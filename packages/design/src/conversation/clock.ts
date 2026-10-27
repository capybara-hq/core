import { useEffect, useState } from "react";

/**
 * The clock of a running row (final review I3): `fixed` when the caller passes one (fixtures,
 * screenshots, a group that ticks for its rows), else the time now, ticking each second only
 * while `active`. Each running element ticks on its own, so the page around it does not re-render.
 */
export function useClock(active: boolean, fixed: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const own = active && fixed === undefined;
  useEffect(() => {
    if (!own) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [own]);
  return fixed ?? (own ? now : Date.now());
}
