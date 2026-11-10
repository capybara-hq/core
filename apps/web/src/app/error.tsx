"use client";

import { ErrorFrame } from "../components/ErrorFrame";

/**
 * A failing route-group layout (the `(app)` layout's shell read, an auth layout): a segment's own
 * `error.tsx` does not catch its layout, so the root's does, inside the root providers.
 */
export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return <ErrorFrame reset={reset} safeReload />;
}
