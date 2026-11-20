"use client";

import { Button, SecretReveal, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { revealInvitationLink } from "../lib/approvals";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * Under an approved `orgs.invite` card, for the person who approved it: a button that reads the
 * invitation's link once (the kernel deletes it as it answers) and shows it in a secret field to
 * copy. The link lives only in this component's state: never in the query cache, the conversation
 * or the tool result (platform web parity spec §7.2).
 */
export function InvitationLinkReveal({ orgId, approvalId }: { orgId: string; approvalId: string }) {
  const t = useTranslations("approval.invitationLink");
  const errorMessage = useErrorMessage();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  // read already or expired (404): nothing left to show, so the button goes
  const [gone, setGone] = useState(false);
  // nothing cached reads the link: there is nothing to invalidate
  const { mutateAsync, isPending } = useAppMutation({
    fn: () => revealInvitationLink(orgId, approvalId),
    invalidates: () => [],
  });

  async function onShow() {
    setError(undefined);
    try {
      const r = await mutateAsync();
      // a deployment without a public URL answers with the path on this origin
      setUrl(new URL(r.url, window.location.origin).href);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiClientError && e.status === 404) setGone(true);
    }
  }

  if (url !== null) {
    return (
      <Stack gap={8}>
        <SecretReveal label={t("label")} value={url} />
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
