"use client";

import { Button, Dialog, Skeleton, Stack, Text, TextLink } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { listMembers } from "../lib/members";
import { leaveOrg } from "../lib/orgs";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";
import { FormError } from "./form-error";

/**
 * 退出组织… (any member; the kernel refuses the last owner): a confirmation saying what leaving
 * does. An owner's dialog first counts the owners; the only owner is told to transfer ownership
 * and gets no confirm button. The kernel ends every session of the account when it offboards, so
 * `onLeft` signs out.
 */
export function LeaveOrgDialog({
  orgId,
  owner,
  onClose,
  onLeft,
}: {
  orgId: string;
  /** The viewer is an owner of the org. */
  owner: boolean;
  onClose(): void;
  onLeft(): void;
}) {
  const t = useTranslations("orgLifecycle.leave");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owners = useLoad(
    () =>
      owner
        ? listMembers(orgId).then((r) => r.members.filter((m) => m.role === "owner").length)
        : Promise.resolve(0),
    [orgId, owner],
  );
  const lastOwner = owner && owners.state.kind === "ready" && owners.state.data <= 1;
  const checking = owner && owners.state.kind === "loading";
  // Couldn't count the owners: say so (with a retry) rather than offer a leave that may be refused
  const countFailed = owner && owners.state.kind === "error";
  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await leaveOrg(orgId);
      onLeft();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          {countFailed ? <Button onClick={owners.reload}>{tc("retry")}</Button> : null}
          {lastOwner || checking || countFailed ? null : (
            <Button variant="danger-solid" loading={busy} onClick={() => void leave()}>
              {t("confirm")}
            </Button>
          )}
        </>
      }
    >
      {checking ? (
        <Skeleton rows={2} />
      ) : countFailed && owners.state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, owners.state.code, ""))} />
      ) : lastOwner ? (
        <Stack gap={8}>
          <Text>{t("lastOwner")}</Text>
          <TextLink href="/settings/members">{t("toMembers")}</TextLink>
        </Stack>
      ) : (
        <Text>{t("description")}</Text>
      )}
      {error !== null && <FormError message={error} />}
    </Dialog>
  );
}
