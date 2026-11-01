"use client";

import { ErrorFrame } from "../../components/ErrorFrame";

/** A failing sign-in, setup, invitation or binding page. */
export default function AuthError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return <ErrorFrame reset={reset} />;
}
