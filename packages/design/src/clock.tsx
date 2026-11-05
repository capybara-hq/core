import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

/**
 * The clock a server render used: its time (ms since the epoch) and the IANA time zone it formatted
 * local times in. The server passes it down with the page; the browser renders with it until it
 * has hydrated, so server-rendered times ("5 分钟前", `MM-DD HH:mm`, a running duration) never
 * differ from the first client render, then switches to its own clock and zone.
 */
export type ServerClock = { now: number; timeZone: string };

const ServerClockContext = createContext<ServerClock | null>(null);

/**
 * Provides the server render's clock ({@link ServerClock}) to {@link useNow} and
 * {@link useTimeZone} (`DesignProvider`'s `clock`). Without it (tests, client-only trees) both use
 * the browser's clock at once.
 */
export function ServerClockProvider({
  clock,
  children,
}: {
  clock: ServerClock | undefined;
  children: ReactNode;
}) {
  return (
    <ServerClockContext.Provider value={clock ?? null}>{children}</ServerClockContext.Provider>
  );
}

/**
 * The time now, cached for up to a second (each timer tick refreshes it): `useSyncExternalStore`
 * needs a snapshot that does not change between two calls unless the store did (otherwise it
 * re-renders forever).
 */
let cachedNow = 0;
function clientNow(): number {
  const t = Date.now();
  if (t - cachedNow >= 1000 || t < cachedNow) cachedNow = t;
  return cachedNow;
}

const never = () => () => {};

/** One browser timer per period, shared by every element re-reading the time at that period. */
const timers = new Map<
  number,
  { listeners: Set<() => void>; id: ReturnType<typeof setInterval> }
>();

function tick(periodMs: number, notify: () => void): () => void {
  if (periodMs <= 0) return () => {};
  let timer = timers.get(periodMs);
  if (timer === undefined) {
    const listeners = new Set<() => void>();
    const id = setInterval(() => {
      cachedNow = Date.now();
      for (const l of listeners) l();
    }, periodMs);
    timer = { listeners, id };
    timers.set(periodMs, timer);
  }
  const t = timer;
  t.listeners.add(notify);
  return () => {
    t.listeners.delete(notify);
    if (t.listeners.size === 0) {
      clearInterval(t.id);
      timers.delete(periodMs);
    }
  };
}

/**
 * The time now for rendering (ms since the epoch). The server render and the browser's hydration
 * read the server's time ({@link ServerClockProvider}), so the two agree; right after hydration and
 * in every later render it is the browser's time, re-read every `updateMs` (0: only when the
 * component re-renders for another reason). Elements mounted after hydration (a client-side
 * navigation) start with the browser's time.
 */
export function useNow(updateMs = 30_000): number {
  const server = useContext(ServerClockContext);
  const subscribe = useCallback((notify: () => void) => tick(updateMs, notify), [updateMs]);
  return useSyncExternalStore(subscribe, clientNow, () => server?.now ?? clientNow());
}

let browserZone: string | undefined;
const localZone = (): string => {
  browserZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return browserZone;
};

/**
 * The IANA time zone local times are written in: the server's ({@link ServerClockProvider}) in
 * the server render and the hydration, the browser's afterwards (`undefined` without a provider on
 * the server: the process's zone).
 */
export function useTimeZone(): string | undefined {
  const server = useContext(ServerClockContext);
  return useSyncExternalStore(never, localZone, () => server?.timeZone);
}
