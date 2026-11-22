import { SIZE_CLASS_QUERIES, useSizeClass } from "./size-class";
import { useHydrated, useMediaQuery } from "./use-media-query";
import { useTouch } from "./touch";

export function ByClass() {
  const pre = !useHydrated();
  const sizeClass = useSizeClass();
  return pre ? "both" : sizeClass;
}

export function ByQuery() {
  const hydrated = useHydrated();
  const narrow = useMediaQuery(SIZE_CLASS_QUERIES.compact);
  return hydrated && narrow ? "a" : "b";
}

export function ByTouch() {
  const hydrated = useHydrated();
  const touch = useTouch();
  return hydrated && touch ? "a" : "b";
}
