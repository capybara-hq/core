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

// Evasions: a namespace import and the bare globals.
import * as design from "@capybara-hq/design";

export function Evasions() {
  const sizeClass = design.useSizeClass();
  const coarse = matchMedia("(pointer: coarse)").matches;
  const wide = innerWidth > 900;
  return [sizeClass, coarse, wide];
}

// A locally bound name is not the global.
export function Bound(matchMedia: (q: string) => boolean) {
  const innerWidth = 3;
  return [matchMedia("x"), innerWidth, design.Button];
}

// Names in key and type positions are not reads.
export type P = { innerWidth: number; matchMedia(): void };
export class K {
  innerWidth = 1;
  matchMedia() {}
}
export type T = typeof innerWidth;

// Destructuring evasions are reads.
export function Destructure() {
  const { innerWidth: w } = window;
  const { useSizeClass: u } = design;
  return [w, u];
}

// The class forms and the other size queries are size-class logic too.
import {
  COMPACT_QUERY,
  ClassForms,
  INLINE_RIGHT_AREA_BELOW,
  INLINE_RIGHT_AREA_QUERY,
  MOBILE_SIZE_QUERY,
  useClassForm,
  useMobileSizes,
} from "@capybara-hq/design";

// A page never reads the native shell either: useNative is a design-side hook.
import { useNative } from "@capybara-hq/design";
