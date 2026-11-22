"use client";

import { type Brand, useThemeColorMeta } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  type BrandRef,
  brandCookieHeader,
  brandRefOf,
  decodeBrandCookie,
  encodeBrandCookie,
} from "../lib/brand-cookie";
import { useProductName } from "../lib/product-name";
import { retryOnMountOf } from "../lib/query/client";
import { orgThemesQuery, platformThemeQuery } from "../lib/query/themes";
import type { ThemeRef } from "../lib/themes";
import { BrandRoot } from "./design-root";
import { ThemeLink } from "./theme-link";

const ThemeContext = createContext<ThemeRef | null>(null);

/** The viewer's resolved theme under a `ThemeRoot`; null: the built-in theme. */
export function useResolvedTheme(): ThemeRef | null {
  return useContext(ThemeContext);
}

/**
 * The viewer's theme (themes spec §8) for the pages below: its stylesheet link, its brand in the
 * design context and `useResolvedTheme()`. With an org, the org's themes read (the workspace layout
 * prefetched it with the shell); without one, the platform default (the auth layout's read). It
 * reads from the query cache, so a settings change that invalidates the read swaps the theme.
 */
export function ThemeRoot({ orgId, children }: { orgId: string | null; children: ReactNode }) {
  return orgId === null ? (
    <PlatformTheme>{children}</PlatformTheme>
  ) : (
    <OrgTheme orgId={orgId}>{children}</OrgTheme>
  );
}

function OrgTheme({ orgId, children }: { orgId: string; children: ReactNode }) {
  const q = orgThemesQuery(orgId);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  return (
    <Themed theme={read.data?.resolved ?? null} answered={read.data !== undefined}>
      {children}
    </Themed>
  );
}

function PlatformTheme({ children }: { children: ReactNode }) {
  const q = platformThemeQuery();
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  return (
    <Themed theme={read.data ?? null} answered={read.data !== undefined}>
      {children}
    </Themed>
  );
}

/** The theme stylesheets React hoisted into `<head>` (`ThemeLink`). */
const THEME_SHEETS = 'link[rel="stylesheet"][data-precedence="theme"]';

/**
 * Leaves only the current theme's stylesheet active. A `precedence` link is a React 19 resource:
 * React never removes a superseded one from `<head>` (an href change or an unmount only drops its
 * count), so after a switch the old sheets would still apply, and on A → B → A the reused node of A
 * would sit before B's and lose to it. Each commit disables every theme stylesheet but the current
 * one (none for the built-in theme), so the order of the nodes no longer matters. The server render
 * holds only the current link, so the first paint is unchanged.
 */
export function useOnlyThemeSheet(cssUrl: string | null): void {
  useLayoutEffect(() => {
    for (const link of document.querySelectorAll<HTMLLinkElement>(THEME_SHEETS)) {
      link.disabled = link.getAttribute("href") !== cssUrl;
    }
  }, [cssUrl]);
}

/**
 * What the theme replaces of the brand, for the design context (theme brand coverage §3): its mark,
 * wordmark, empty-state illustration and sign-in decoration; null when it replaces nothing (the
 * built-in look). The product name (issue #452) is only the theme mark's alt: without a theme
 * wordmark the built-in CAPYBARA stays beside the pixel capybara (decision 7), so a product name
 * alone makes no brand.
 */
export function brandOf(theme: ThemeRef | null, productName: string | null): Brand | null {
  return brandOfRef(theme === null ? null : brandRefOf(theme), productName);
}

/** {@link brandOf} of a theme reference an outside page has (the brand cookie, `StaticTheme`). */
export function brandOfRef(ref: BrandRef | null, productName: string | null): Brand | null {
  const markUrl = ref?.markUrl ?? null;
  const wordmark = ref?.wordmark ?? null;
  const illustrationUrl = ref?.illustrationUrl ?? null;
  const decoration = ref?.decoration === "none" ? "none" : "dither";
  if (markUrl === null && wordmark === null && illustrationUrl === null && decoration === "dither")
    return null;
  return { markUrl, wordmark, illustrationUrl, decoration, productName };
}

/**
 * Stores the drawn theme in the brand cookie (theme brand coverage spec §5) for the pages outside
 * the route-group layouts: on every themed document (renewing its 30 days) and after each commit
 * whose drawn theme changes; deleted under the built-in theme. Nothing while the theme read has no
 * answer (pending or failed: the last theme drawn stays, which is what a kernel-down page wants).
 */
function useBrandCookieWrite(theme: ThemeRef | null, answered: boolean): void {
  const value = theme === null ? null : encodeBrandCookie(brandRefOf(theme));
  useEffect(() => {
    if (!answered) return;
    // a theme the cookie cannot hold (over 1 KB) deletes it, as the built-in theme does
    const ref = value === null ? null : decodeBrandCookie(value);
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and not everywhere
    document.cookie = brandCookieHeader(ref, location.protocol === "https:");
  }, [answered, value]);
}

function Themed({
  theme,
  answered,
  children,
}: {
  theme: ThemeRef | null;
  answered: boolean;
  children: ReactNode;
}) {
  useOnlyThemeSheet(theme?.cssUrl ?? null);
  useBrandCookieWrite(theme, answered);
  useThemeColorMeta(theme?.cssUrl ?? null);
  const productName = useProductName();
  const brand = useMemo(() => brandOf(theme, productName), [theme, productName]);
  return (
    <ThemeContext.Provider value={theme}>
      <ThemeLink theme={theme} />
      <BrandRoot brand={brand}>{children}</BrandRoot>
    </ThemeContext.Provider>
  );
}
