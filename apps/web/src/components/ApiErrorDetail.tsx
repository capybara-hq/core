"use client";

import { ErrorDetail } from "@capybara-hq/design";
import { ApiClientError } from "../lib/api";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * A failed call as one sentence mapped from its error code, the kernel's own message (which may
 * hold the next step, such as the command to run on a machine) behind the 「原始错误」 toggle.
 */
export function ApiErrorDetail({
  error,
  open = false,
  summaries = {},
}: {
  error: unknown;
  /** Show the kernel's message at once (it holds the next step). */
  open?: boolean;
  /** A sentence of this place's own for some codes (the shared `errors.*` one is too general). */
  summaries?: Record<string, string>;
}) {
  const errorMessage = useErrorMessage();
  const detail = error instanceof ApiClientError ? error.message : undefined;
  const own = error instanceof ApiClientError ? summaries[error.code] : undefined;
  return (
    <div role="alert">
      <ErrorDetail
        summary={own ?? errorMessage(error)}
        defaultOpen={open}
        {...(detail !== undefined && detail !== "" ? { detail } : {})}
      />
    </div>
  );
}
