import { useCallback, useSyncExternalStore } from "react";

/** SSR 与首次水合一律 false，水合后订阅真实结果。 */
export function useMediaQuery(query: string): boolean {
  // 按 query 稳定订阅函数，避免每次渲染都重新订阅
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

const noSubscribe = () => () => {};

/** False on the server and during hydration, true after (and in client-only renders). */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
