"use client";

import { Button, Dialog, EmptyState, Field, Select, Skeleton, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reassignAgentOwner } from "../lib/agents";
import { keys } from "../lib/query/keys";
import { membersQuery } from "../lib/query/members";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * 更改所有者 (org admins, `agents.manage`): pick a member of the org (anonymous guests can't own
 * agents, the kernel refuses them) and `POST …/agents/:id/owner`, which invalidates the agents list
 * and the agent. `onDone` after success.
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
  const membersQ = useQuery(membersQuery(orgId));
  const reassign = useAppMutation({
    fn: (accountId: string) => reassignAgentOwner(orgId, agentId, accountId),
    invalidates: () => [keys.org(orgId).agents(), keys.org(orgId).agent(agentId)],
    onSuccess: () => {
      toast.success(t("done"));
      onDone?.();
      onClose();
    },
  });
  const [picked, setPicked] = useState<string | null>(null);
  const members = (membersQ.data?.members ?? []).filter((m) => !m.anonymous);
  const value =
    picked ?? (members.some((m) => m.account.id === ownerAccountId) ? ownerAccountId : "");
  const error = reassign.error ? errorMessage(reassign.error) : null;
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
            loading={reassign.isPending}
            disabled={value === "" || (value === ownerAccountId && !needsReassignment)}
            onClick={() => reassign.mutate(value)}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      {membersQ.data === undefined && membersQ.error === null ? (
        <Skeleton rows={2} />
      ) : membersQ.data === undefined ? (
        <FormError message={errorMessage(membersQ.error)} />
      ) : members.length === 0 ? (
        <EmptyState size="panel" text={t("none")} />
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
