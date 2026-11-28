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

/**
 * Thrown in development and tests by a page-frame component without exactly one template, or by a
 * host-framed component that renders one (`expected` 0: the host's frame is its page already).
 */
export class TemplateCountError extends Error {
  constructor(where: string, count: number, expected: 0 | 1 = 1) {
    super(
      expected === 1
        ? `${where} is a page-frame component (frame: "page"): it must render exactly one page ` +
            `template (ListPage, DetailPage, FormPage or SettingsPage from @capybara-hq/plugin-client); ` +
            `it rendered ${count}.`
        : `${where} is drawn in the host's frame (frame: "host"): it must render no page template ` +
            `(ListPage, DetailPage, FormPage or SettingsPage), the host draws the page around it; ` +
            `it rendered ${count}. A component that draws its whole page declares frame: "page".`,
    );
    this.name = "TemplateCountError";
  }
}

/**
 * A notice the host shows in the forwarded template's header (`header.notice`): a page-frame
 * component draws its own page, so a host line (live refresh stopped) goes inside it, not above.
 */
const HostNoticeContext = createContext<ReactNode>(null);
export const HostNoticeProvider = HostNoticeContext.Provider;

/** The host's notice for the forwarded template's header; null when there is none. */
export function useHostNotice(): ReactNode {
  return useContext(HostNoticeContext);
}

const PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Wraps a client component (plugin full pages spec §2) and counts the forwarded page templates
 * mounted below it after every commit (and every template mount or unmount): a `frame: "page"`
 * component (`expected` 1) must mount exactly one, a component in the host's frame (`expected` 0,
 * the default for every other component) none, since a template there would nest a page in the
 * host's. In development and tests a wrong count throws while rendering, so the component's block
 * boundary shows its failure line and the crash counts against the plugin's crash budget (as
 * `assertSectionGroups` throws for form sections); in production it logs once. `where`: the
 * contribution, for the message.
 */
export function TemplateGuard({
  where,
  expected = 1,
  children,
}: {
  where: string;
  expected?: 0 | 1;
  children?: ReactNode;
}) {
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
    if (n === expected) return;
    if (!PRODUCTION) {
      setWrong(n);
      return;
    }
    if (!logged.current) {
      logged.current = true;
      console.error(new TemplateCountError(where, n, expected).message);
    }
  });
  if (wrong !== null) throw new TemplateCountError(where, wrong, expected);
  return <TemplateCountContext.Provider value={counter}>{children}</TemplateCountContext.Provider>;
}
