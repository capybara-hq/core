"use client";

import { ErrorDetail } from "@capybara-hq/design";
import { ApiClientError } from "../lib/api";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * A failed call as one sentence mapped from its error code, the kernel's own message (which may
 * hold the next step, such as the command to run on a machine) behind the 「原始错误」 toggle.
 */
export function ApiErrorDetail({ error, open = false }: { error: unknown; open?: boolean }) {
  const errorMessage = useErrorMessage();
  const detail = error instanceof ApiClientError ? error.message : undefined;
  return (
    <div role="alert">
      <ErrorDetail
        summary={errorMessage(error)}
        defaultOpen={open}
        {...(detail !== undefined && detail !== "" ? { detail } : {})}
      />
    </div>
  );
}
