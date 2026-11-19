"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  Dialog,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { usePageQuery } from "../lib/query/page-query";
import { useRevokeShare } from "../lib/query/share-mutations";
import { orgSharesQuery } from "../lib/query/shares";
import type { ShareState, ShareView } from "../lib/shares";
import { useErrorMessage } from "../lib/use-error-message";
import { ErrorFrame } from "./ErrorFrame";
import { FormError } from "./form-error";

const STATUS: Record<ShareState, ComponentProps<typeof StatusMark>["status"]> = {
  live: "success",
  expired: "cancelled",
  revoked: "cancelled",
  suspended: "waiting",
};

/**
 * The org's shared file links as a table (file sharing spec §8): file, owner, audience, expiry,
 * last opened and state, with Revoke (after a confirmation) on a link that still works. `all` is
 * every link of the org (org admins), `mine` the person's own. A revoke invalidates the lists, so
 * the row comes back in its revoked state.
 */
export function SharesTable({ orgId, scope }: { orgId: string; scope: "mine" | "all" }) {
  const t = useTranslations("shares");
  const read = usePageQuery(orgSharesQuery(orgId, scope));
  const [revoking, setRevoking] = useState<ShareView | null>(null);
  if (read.kind === "notFound" || read.kind === "error") {
    return <ErrorFrame reset={read.kind === "error" ? read.retry : () => location.reload()} />;
  }
  const rows = read.kind === "ready" ? read.data : [];
  const columns: Column<ShareView>[] = [
    { key: "file", header: t("list.file"), cell: (r) => r.name },
    ...(scope === "all"
      ? [
          {
            key: "owner",
            header: t("list.owner"),
            cell: (r: ShareView) => r.createdBy.displayName,
          },
        ]
      : []),
    {
      key: "audience",
      header: t("list.audience"),
      cell: (r) => t(`dialog.${r.audience}`),
    },
    {
      key: "expiry",
      header: t("list.expiry"),
      tone: "muted",
      cell: (r) => (r.expiresAt === null ? t("dialog.noExpiry") : <DateTime value={r.expiresAt} />),
    },
    {
      key: "lastOpened",
      header: t("list.lastOpened"),
      tone: "muted",
      cell: (r) =>
        r.lastOpenedAt === null ? t("list.neverOpened") : <DateTime value={r.lastOpenedAt} />,
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (r) => (
        <StatusMark
          status={STATUS[r.state]}
          label={t(r.state === "live" ? "list.stateLive" : `dialog.${r.state}`)}
        />
      ),
    },
    {
      key: "actions",
      header: t("list.actions"),
      align: "right",
      cell: (r) =>
        r.state === "revoked" || r.state === "expired" ? null : (
          <Button
            density="dense"
            variant="danger"
            aria-label={`${t("list.revoke")} ${r.name}`}
            onClick={() => setRevoking(r)}
          >
            {t("list.revoke")}
          </Button>
        ),
    },
  ];
  return (
    <>
      <DataTable<ShareView>
        label={scope === "all" ? t("list.title") : t("list.mineTitle")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        state={read.kind === "ready" ? "ready" : "loading"}
        empty={{ title: t("list.empty") }}
      />
      {revoking !== null ? (
        <RevokeDialog orgId={orgId} share={revoking} onClose={() => setRevoking(null)} />
      ) : null}
    </>
  );
}

function RevokeDialog({
  orgId,
  share,
  onClose,
}: {
  orgId: string;
  share: ShareView;
  onClose(): void;
}) {
  const t = useTranslations("shares.list");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const revoke = useRevokeShare(orgId);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await revoke.mutateAsync({ shareId: share.id, conversationId: share.conversationId });
      toast.success(t("revokedToast"));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
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
      title={t("revokeTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="danger-solid" loading={revoke.isPending} onClick={() => void confirm()}>
            {t("revokeConfirm")}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t("revokeDescription", { name: share.name })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
