import { createContext, useContext, useEffect, useRef } from "react";
import type { ConvMenuEntry } from "../conversation/menu";

/** What a page tells the shell about itself: the compact top bar's title, back target and menu. */
export type ShellPage = {
  title?: string;
  path?: { label: string; href?: string | undefined }[];
  menu?: ConvMenuEntry[];
  /**
   * An open item of a list-detail region (spec §6.47): the page is pushed while it is set, so the
   * compact top bar shows back (calling this) and the bottom navigation hides.
   */
  onBack?: () => void;
};

type Register = (id: symbol, page: ShellPage | null) => void;

/** Provided by `AppShell`; pages register through {@link useRegisterShellPage}. */
export const ShellPageContext = createContext<Register | null>(null);

/**
 * A page tells the shell its name and path (the PageHeader does, for every template), so the
 * compact top bar shows the title and knows where back goes (design spec §4.6, §6.46); a page may
 * add its overflow menu. The registration lasts while the page is mounted.
 */
export function useRegisterShellPage(page: ShellPage): void {
  const register = useContext(ShellPageContext);
  const id = useRef<symbol>(Symbol("shell-page"));
  const key = JSON.stringify([page.title, page.path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for title and path
  useEffect(() => {
    register?.(id.current, page);
  }, [register, key, page.menu, page.onBack]);
  useEffect(() => {
    const own = id.current;
    return () => register?.(own, null);
  }, [register]);
}

/** Whether the page is inside an `AppShell` (its top bar owns back for a pushed page). */
export function useHasShell(): boolean {
  return useContext(ShellPageContext) !== null;
}
