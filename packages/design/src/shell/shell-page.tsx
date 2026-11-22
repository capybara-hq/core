import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { ConvMenuEntry } from "../conversation/menu";
import type { MenuItem } from "../overlays/menus";

/** What a page tells the shell about itself: the compact floating row's title, back and menu. */
export type ShellPage = {
  title?: string;
  path?: { label: string; href?: string | undefined }[];
  menu?: ConvMenuEntry[];
  /**
   * An open item of a list-detail region (spec §6.47): the page is pushed while it is set, so the
   * compact floating row shows back (calling this).
   */
  onBack?: () => void;
  /**
   * The head's secondary actions (responsive system spec §2.5, D1): on compact they join the
   * floating row's trailing overflow after `menu`. A link (`href`) navigates through the shell's
   * `onNavigate`, else `window.location.assign`. The template registers them.
   */
  actions?: MenuItem[];
  /**
   * The page's large title has scrolled under the floating row (design spec §6.65): the row draws
   * `title` centred with a hairline under its strip. Registered by {@link useRegisterScrolledTitle}.
   */
  titleAway?: boolean;
  /**
   * The page's primary action (the head's primary, design spec §6.62): while a native strip
   * shows (`nav@1`) on compact, the shell sends it as the strip pill's top item and runs it on a
   * tap (interaction model §10.3, D10); without one the pill carries the new conversation. The
   * template registers it (T0b.9). `id` is a short stable key (letters, digits, `_.-`).
   */
  primary?: ShellPrimary;
};

/** A page's primary action as the shell carries it to the strip (`nav@1` `action`). */
export type ShellPrimary = {
  id: string;
  label: string;
  /** The strip's glyph: `plus` (the default) or `square-pen`. */
  icon?: "plus" | "square-pen";
  run(): void;
};

type Register = (id: symbol, page: ShellPage | null, layer?: number) => void;

/** Provided by `AppShell`; pages register through {@link useRegisterShellPage}. */
export const ShellPageContext = createContext<Register | null>(null);

/**
 * A page tells the shell its name and path (the PageHeader does, for every template), so the
 * compact floating row knows where back goes (design spec §4.6, §6.56); a page may
 * add its overflow menu. The registration lasts while the page is mounted. A part pushed inside the
 * page (a right panel with steps of its own) registers on a higher `layer`: its fields win over the
 * page's whatever order the two mounted in.
 */
export function useRegisterShellPage(page: ShellPage, layer = 0): void {
  const register = useContext(ShellPageContext);
  const id = useRef<symbol>(Symbol("shell-page"));
  const key = JSON.stringify([
    page.title,
    page.path,
    page.titleAway,
    page.primary && [page.primary.id, page.primary.label, page.primary.icon],
  ]);
  // Layout effects: the row follows the page before paint (a restored scroll's titleAway lands
  // with the restored position, no late flash).
  // the primary's latest `run` (an inline function changes every render): called through a ref
  const run = useRef(page.primary?.run);
  run.current = page.primary?.run;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for title, path, titleAway and the primary's fields
  useLayoutEffect(() => {
    const p = page.primary;
    register?.(
      id.current,
      p === undefined
        ? page
        : {
            ...page,
            primary: {
              id: p.id,
              label: p.label,
              ...(p.icon ? { icon: p.icon } : {}),
              run: () => run.current?.(),
            },
          },
      layer,
    );
  }, [register, key, page.menu, page.actions, page.onBack, layer]);
  useLayoutEffect(() => {
    const own = id.current;
    return () => register?.(own, null);
  }, [register]);
}

/**
 * A page's one scroller reports whether its large title has passed under the compact floating row
 * (`useCompactScroll`'s `titleAway`, design spec §6.65), on the page's `layer`; the row then draws
 * the registered title centred.
 */
export function useRegisterScrolledTitle(titleAway: boolean, layer = 0): void {
  useRegisterShellPage({ titleAway }, layer);
}

/** Whether the page is inside an `AppShell` (its floating row owns back for a pushed page). */
export function useHasShell(): boolean {
  return useContext(ShellPageContext) !== null;
}
