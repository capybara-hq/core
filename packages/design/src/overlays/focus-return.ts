import { useRef } from "react";

/** 触发元素常在浮层之外受控打开，Radix 不认识它，所以自己记录并归还焦点（spec §8）。 */
export function useFocusReturn() {
  const returnTo = useRef<HTMLElement | null>(null);
  return {
    capture() {
      returnTo.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restore(e: Event) {
      const el = returnTo.current;
      returnTo.current = null;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}
