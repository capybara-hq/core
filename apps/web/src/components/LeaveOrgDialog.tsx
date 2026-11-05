"use client";

import { Button, Dialog, Skeleton, Stack, Text, TextLink } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { leaveOrg } from "../lib/orgs";
import { membersQuery } from "../lib/query/members";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * 退出组织… (any member; the kernel refuses the last owner): a confirmation saying what leaving
 * does. An owner's dialog first counts the owners; the only owner is told to transfer ownership
 * and gets no confirm button: nothing destructive can happen there, so it is a plain dialog with
 * one 知道了 (spec §6.7). Leaving keeps the sign-in (only this org's access ends), so
 * `onLeft` moves to another org or the chooser.
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
  // Only an owner needs the count.
  const members = useQuery({ ...membersQuery(orgId), enabled: owner });
  const owners = members.data?.members.filter((m) => m.role === "owner").length;
  const lastOwner = owner && owners !== undefined && owners <= 1;
  // Couldn't count the owners: say so (with a retry) rather than offer a leave that may be refused
  const countFailed = owner && owners === undefined && members.error !== null;
  const checking = owner && owners === undefined && !countFailed;
  // Leaving moves to another org (`onLeft`), which ends the cache's session.
  const leaveMutation = useAppMutation({ fn: leaveOrg, invalidates: () => [] });
  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await leaveMutation.mutateAsync(orgId);
      onLeft();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  if (lastOwner) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t("title")}
        footer={<Button onClick={onClose}>{t("gotIt")}</Button>}
      >
        <Stack gap={8}>
          <Text variant="prose">{t("lastOwner")}</Text>
          <TextLink href="/settings/members">{t("toMembers")}</TextLink>
        </Stack>
      </Dialog>
    );
  }
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
          {countFailed ? (
            <Button onClick={() => void members.refetch()}>{tc("retry")}</Button>
          ) : null}
          {checking || countFailed ? null : (
            <Button variant="danger-solid" loading={busy} onClick={() => void leave()}>
              {t("confirm")}
            </Button>
          )}
        </>
      }
    >
      {checking ? (
        <Skeleton rows={2} />
      ) : countFailed && members.error !== null ? (
        <FormError message={errorMessage(new ApiClientError(0, members.error.code, ""))} />
      ) : (
        <Text variant="prose">{t("description")}</Text>
      )}
      {error !== null && <FormError message={error} />}
    </Dialog>
  );
}
