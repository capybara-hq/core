"use client";

import { Button, SecretReveal, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { revealInitialPassword } from "../lib/approvals";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * Under an approved `accounts.create` card, for the person who approved it: a button that reads
 * the account's generated initial password once (the kernel deletes it as it answers) and shows it
 * in a secret field. The password lives only in this component's state: never in the query cache,
 * the conversation or the tool result (Platform tool spec §14.5 item 2).
 */
export function InitialPasswordReveal({
  orgId,
  approvalId,
}: {
  orgId: string;
  approvalId: string;
}) {
  const t = useTranslations("approval.initialPassword");
  const errorMessage = useErrorMessage();
  const [shown, setShown] = useState<{ login: string | null; password: string } | null>(null);
  const [error, setError] = useState<string>();
  // read already or expired (404): nothing left to show, so the button goes
  const [gone, setGone] = useState(false);
  // nothing cached reads the password: there is nothing to invalidate
  const { mutateAsync, isPending } = useAppMutation({
    fn: () => revealInitialPassword(orgId, approvalId),
    invalidates: () => [],
  });

  async function onShow() {
    setError(undefined);
    try {
      const r = await mutateAsync();
      setShown({ login: r.login, password: r.password });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiClientError && e.status === 404) setGone(true);
    }
  }

  if (shown !== null) {
    return (
      <Stack gap={8}>
        <SecretReveal label={t("label", { login: shown.login ?? "" })} value={shown.password} />
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap={8} align="start">
      {!gone && (
        <Button onClick={() => void onShow()} loading={isPending}>
          {t("show")}
        </Button>
      )}
      {error !== undefined && <FormError message={error} />}
    </Stack>
  );
}
