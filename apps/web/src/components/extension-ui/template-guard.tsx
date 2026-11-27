"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** What a forwarded page template reports to the guard above it: it is mounted. */
interface TemplateCounter {
  /** Counts one mounted template; the returned function uncounts it. */
  mount(): () => void;
}

const TemplateCountContext = createContext<TemplateCounter | null>(null);

/**
 * Called by every forwarded page template (`ListPage`, `DetailPage`, `FormPage`, `SettingsPage`
 * in `host-api.ts`): counts it under the nearest {@link TemplateGuard}; nothing outside one.
 */
export function useTemplateMark(): void {
  const counter = useContext(TemplateCountContext);
  useLayoutEffect(() => counter?.mount(), [counter]);
}

/** Thrown in development and tests by a page-frame component without exactly one template. */
export class TemplateCountError extends Error {
  constructor(where: string, count: number) {
    super(
      `${where} is a page-frame component (frame: "page"): it must render exactly one page ` +
        `template (ListPage, DetailPage, FormPage or SettingsPage from @capybara-hq/plugin-client); ` +
        `it rendered ${count}.`,
    );
    this.name = "TemplateCountError";
  }
}

const PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Wraps a `frame: "page"` component (plugin full pages spec §2): after every commit of the
 * component (and every template mount or unmount below it) exactly one forwarded page template
 * must be mounted. In development and tests a count other than one throws while rendering, so the
 * component's block boundary shows its failure line and the crash counts against the plugin's
 * crash budget (as `assertSectionGroups` throws for form sections); in production it logs once.
 * `where`: the contribution, for the message.
 */
export function TemplateGuard({ where, children }: { where: string; children?: ReactNode }) {
  const count = useRef(0);
  // a template mounting or unmounting re-renders the guard, so its check below runs again
  const [, setTick] = useState(0);
  const [wrong, setWrong] = useState<number | null>(null);
  const logged = useRef(false);
  const counter = useMemo<TemplateCounter>(
    () => ({
      mount() {
        count.current += 1;
        setTick((t) => t + 1);
        return () => {
          count.current -= 1;
          setTick((t) => t + 1);
        };
      },
    }),
    [],
  );
  // after every commit of the guard: the templates' layout effects ran before this one
  useLayoutEffect(() => {
    const n = count.current;
    if (n === 1) return;
    if (!PRODUCTION) {
      setWrong(n);
      return;
    }
    if (!logged.current) {
      logged.current = true;
      console.error(new TemplateCountError(where, n).message);
    }
  });
  if (wrong !== null) throw new TemplateCountError(where, wrong);
  return <TemplateCountContext.Provider value={counter}>{children}</TemplateCountContext.Provider>;
}
