"use client";

import { useThemeColorMeta } from "@capybara-hq/design";
import { type ReactNode, useMemo } from "react";
import type { BrandRef } from "../lib/brand-cookie";
import { useProductName } from "../lib/product-name";
import { BrandRoot } from "./design-root";
import { ThemeLink } from "./theme-link";
import { brandOfRef, useOnlyThemeSheet } from "./theme-root";

/**
 * A theme for a page outside the route-group layouts (theme brand coverage spec §5), from a
 * reference instead of a query (`outsideTheme()` on the server, `useBrandCookie()` in the browser):
 * links its stylesheet (`ThemeLink`, the only theme sheet enabled) and provides its brand (`BrandRoot`); null is the built-in
 * theme. When the kernel is down the stylesheet and assets come from the browser's cache (immutable
 * URLs); a browser without them keeps the built-in tokens and the `Logo` fallback.
 */
export function StaticTheme({ brand, children }: { brand: BrandRef | null; children: ReactNode }) {
  const productName = useProductName();
  const design = useMemo(() => brandOfRef(brand, productName), [brand, productName]);
  // a sheet a ThemeRoot left in <head> before this page replaced it stops applying
  useOnlyThemeSheet(brand?.cssUrl ?? null);
  useThemeColorMeta(brand?.cssUrl ?? null);
  return (
    <>
      <ThemeLink theme={brand} />
      <BrandRoot brand={design}>{children}</BrandRoot>
    </>
  );
}
