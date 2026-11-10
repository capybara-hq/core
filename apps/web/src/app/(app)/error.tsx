"use client";

import { ErrorFrame } from "../../components/ErrorFrame";

/** A failing `(app)` page (any server error but sign-in and not found): drawn inside the shell. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset(): void }) {
  return <ErrorFrame reset={reset} safeReload />;
}
