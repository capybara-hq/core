import { useNow } from "../clock";

/**
 * The clock of a running row (final review I3): `fixed` when the caller passes one (fixtures,
 * screenshots, a group that ticks for its rows), else the time now ({@link useNow}: the server's
 * time while hydrating), ticking each second only while `active`. Each running element ticks on
 * its own, so the page around it does not re-render.
 */
export function useClock(active: boolean, fixed: number | undefined): number {
  const now = useNow(active && fixed === undefined ? 1000 : 0);
  return fixed ?? now;
}
