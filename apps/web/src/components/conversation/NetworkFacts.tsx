"use client";

import {
  Button,
  type CalloutAction,
  Dialog,
  Field,
  NetworkBlockedFacts,
  type NetworkFact,
  Stack,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { requestNetworkHosts } from "../../lib/catalog";
import { canUpdateOrg } from "../../lib/org-settings";
import { retryOnMountOf } from "../../lib/query/client";
import { conversationQuery } from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import { orgSettingsQuery } from "../../lib/query/settings";
import { ApiErrorDetail } from "../ApiErrorDetail";
import { useSession } from "../shell/session";

/** The longest note a network request carries (the kernel's limit). */
const NOTE_MAX = 500;

/**
 * Hosts a command was refused that no card can lift (network ask spec §5.3, §6.5), with the org
 * layer's next step: a member's 「请管理员添加」 (a request to the org admins, with an optional
 * note), an org admin's 「去组织设置添加」 (the org's sandbox settings with the hosts prefilled), or,
 * when the platform turned sandbox network off, the sentence saying only a super admin can turn it
 * on (no action). Never a one-click widening of the org's list (§13 Q4).
 */
export function NetworkFacts({
  orgId,
  conversationId,
  hosts,
}: {
  orgId: string;
  conversationId: string;
  hosts: NetworkFact[];
}) {
  const t = useTranslations("networkAsk");
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const orgHosts = hosts.filter((h) => h.layer === "org").map((h) => h.host);
  const settingsQ = orgSettingsQuery(orgId);
  const settings = useQuery({
    ...settingsQ,
    enabled: orgHosts.length > 0,
    retryOnMount: retryOnMountOf(settingsQ.queryKey),
  }).data;
  const platformOff = settings?.deployment?.sandboxEgress.mode === "none";
  const [asking, setAsking] = useState(false);
  const action: CalloutAction | undefined =
    orgHosts.length === 0 || platformOff
      ? undefined
      : admin
        ? {
            label: t("openSettings"),
            href: `/settings/sandbox?allowHost=${encodeURIComponent(orgHosts.join(","))}`,
          }
        : { label: t("ask"), onSelect: () => setAsking(true) };
  return (
    <Stack gap={4}>
      <NetworkBlockedFacts hosts={hosts} {...(action ? { action } : {})} />
      {orgHosts.length > 0 && platformOff && (
        <Text variant="small" tone="muted">
          {t("platformOff")}
        </Text>
      )}
      {asking && (
        <AskAdminDialog
          orgId={orgId}
          conversationId={conversationId}
          hosts={orgHosts}
          onClose={() => setAsking(false)}
        />
      )}
    </Stack>
  );
}

/**
 * 请管理员添加: the hosts, an optional note, then the request; the org admins get it in their inbox.
 * A refusal (the platform turned network off, the hosts are allowed already) shows the kernel's
 * reason and keeps the dialog open.
 */
function AskAdminDialog({
  orgId,
  conversationId,
  hosts,
  onClose,
}: {
  orgId: string;
  conversationId: string;
  hosts: string[];
  onClose(): void;
}) {
  const t = useTranslations("networkAsk");
  const tc = useTranslations("common");
  const toast = useToast();
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  // the conversation's agent, for the admins' context (the thread's conversation is cached)
  const rowQ = conversationQuery(orgId, conversationId);
  const agentId = useQuery({ ...rowQ, retryOnMount: retryOnMountOf(rowQ.queryKey) }).data?.agentId;
  // the request changes nothing the requester reads until it is decided
  const send = useAppMutation({
    fn: () =>
      requestNetworkHosts(orgId, {
        hosts,
        conversationId,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(note.trim() !== "" ? { note: note.trim() } : {}),
      }),
    invalidates: () => [],
  });
  const submit = async () => {
    setFailure(null);
    try {
      await send.mutateAsync(undefined);
      toast.success(t("sent"));
      onClose();
    } catch (e) {
      setFailure(e);
    }
  };
  const pending = send.isPending;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
      title={t("dialogTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("send")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("dialogBody", { hosts: hosts.join(", ") })}</Text>
        <Field label={t("note")} optional help={t("noteHelp")}>
          <Textarea
            name="note"
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {failure !== null && (
          <ApiErrorDetail
            error={failure}
            open
            summaries={{ "catalog.request_invalid": t("refused") }}
          />
        )}
      </Stack>
    </Dialog>
  );
}
