"use client";

import type { Brand } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
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
  const theme = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.resolved ?? null;
  return <Themed theme={theme}>{children}</Themed>;
}

function PlatformTheme({ children }: { children: ReactNode }) {
  const q = platformThemeQuery();
  const theme = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data ?? null;
  return <Themed theme={theme}>{children}</Themed>;
}

function Themed({ theme, children }: { theme: ThemeRef | null; children: ReactNode }) {
  const markUrl = theme?.logo?.markUrl ?? null;
  const wordmark = theme?.logo?.wordmark ?? null;
  const brand = useMemo<Brand | null>(
    () => (markUrl === null && wordmark === null ? null : { markUrl, wordmark }),
    [markUrl, wordmark],
  );
  return (
    <ThemeContext.Provider value={theme}>
      <ThemeLink theme={theme} />
      <BrandRoot brand={brand}>{children}</BrandRoot>
    </ThemeContext.Provider>
  );
}
