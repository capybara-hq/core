import { SIZE_CLASS_QUERIES, TOUCH_QUERY, useMediaQuery, useSizeClass, useTouch } from "@capybara-hq/design";

export function Page() {
  const sizeClass = useSizeClass();
  const touch = useTouch();
  const narrow = useMediaQuery(SIZE_CLASS_QUERIES.compact);
  const coarse = window.matchMedia(TOUCH_QUERY).matches;
  const wide = window.innerWidth > 900;
  return [sizeClass, touch, narrow, coarse, wide];
}

// Not a size branch: other reads of window and a string that only names a hook.
export const fine = typeof window.scrollY === "number" && "useSizeClass".length > 0;
