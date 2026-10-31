"use client";

import { Button, Dialog, Field, Select, Skeleton, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reassignAgentOwner } from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { listMembers } from "../lib/members";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";
import { FormError } from "./form-error";

/**
 * 更换负责人 (org admins, `agents.manage`): pick a member of the org (anonymous guests can't own
 * agents, the kernel refuses them) and `POST …/agents/:id/owner`. `onDone` after success.
 */
export function ReassignOwnerDialog({
  orgId,
  agentId,
  ownerAccountId,
  needsReassignment = false,
  onClose,
  onDone,
}: {
  orgId: string;
  agentId: string;
  ownerAccountId: string;
  /** Confirming the current owner is a change then: the kernel clears the flag. */
  needsReassignment?: boolean;
  onClose(): void;
  onDone?(): void;
}) {
  const t = useTranslations("agents.reassign");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { state } = useLoad(
    () => listMembers(orgId).then((r) => r.members.filter((m) => !m.anonymous)),
    [orgId],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = state.kind === "ready" ? state.data : [];
  const value =
    picked ?? (members.some((m) => m.account.id === ownerAccountId) ? ownerAccountId : "");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await reassignAgentOwner(orgId, agentId, value);
      toast.success(t("done"));
      onDone?.();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={value === "" || (value === ownerAccountId && !needsReassignment)}
            onClick={() => void submit()}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      {state.kind === "loading" ? (
        <Skeleton rows={2} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
      ) : members.length === 0 ? (
        <Text tone="muted">{t("none")}</Text>
      ) : (
        <Field label={t("owner")} help={t("help")}>
          <Select
            value={value}
            onChange={(e) => setPicked(e.target.value)}
            options={[
              ...(value === "" ? [{ value: "", label: "—" }] : []),
              ...members.map((m) => ({
                value: m.account.id,
                label: m.account.email
                  ? `${m.account.displayName} · ${m.account.email}`
                  : m.account.displayName,
              })),
            ]}
          />
        </Field>
      )}
      {error !== null && <FormError message={error} />}
    </Dialog>
  );
}
