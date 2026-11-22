import { SIZE_CLASS_QUERIES, useSizeClass } from "./size-class";
import { useHydrated, useMediaQuery } from "./use-media-query";

// Each alone is fine, and so are the two in different functions.
export function OnlyClass() {
  return useSizeClass();
}

export function OnlyHydrated() {
  return useHydrated();
}

export function OtherQuery() {
  const hydrated = useHydrated();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  return hydrated && reduced;
}

export function Outer() {
  const hydrated = useHydrated();
  // a nested function is its own function
  const inner = () => useMediaQuery(SIZE_CLASS_QUERIES.compact);
  return [hydrated, inner];
}
