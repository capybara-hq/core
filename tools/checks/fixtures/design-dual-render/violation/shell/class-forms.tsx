// The helper itself may pair them.
import { useSizeClass } from "./size-class";
import { useHydrated } from "./use-media-query";

export function ClassForms() {
  const pre = !useHydrated();
  return pre ? "both" : useSizeClass();
}
