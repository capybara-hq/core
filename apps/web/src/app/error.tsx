"use client";

import { ErrorFrame } from "../components/ErrorFrame";
import { StaticTheme } from "../components/static-theme";
import { useBrandCookie } from "../lib/use-brand-cookie";

/**
 * A failing route-group layout (the `(app)` layout's shell read, an auth layout): a segment's own
 * `error.tsx` does not catch its layout, so the root's does, inside the root providers, under the
 * theme this browser last drew (the brand cookie, theme brand coverage spec §5).
 */
export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return (
    <StaticTheme brand={useBrandCookie()}>
      <ErrorFrame reset={reset} safeReload />
    </StaticTheme>
  );
}
