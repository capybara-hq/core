"use client";

import {
  Button,
  CopyField,
  Dialog,
  Field,
  formatDateTime,
  ItemList,
  RadioGroup,
  Select,
  Stack,
  Subsection,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { FileOutput } from "../../lib/files";
import type { LibraryFileView } from "../../lib/library-files";
import {
  useCreateLibraryShare,
  useCreateShare,
  useRefreshShare,
  useRevokeShare,
} from "../../lib/query/share-mutations";
import { fileSharesQuery, libraryFileSharesQuery } from "../../lib/query/shares";
import { browserShare, shareOrCopy } from "../../lib/share";
import { SHARE_EXPIRIES, type ShareExpiry, type ShareView, shareUrl } from "../../lib/shares";
import { useShareCapability } from "../../lib/shell";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";

type Audience = "internal" | "external";

/**
 * What is shared: a conversation's file (the right panel), or one of the person's library files
 * (the Files page; its shares belong to no conversation).
 */
export type ShareTarget =
  | { kind: "conversation"; conversationId: string; file: FileOutput }
  | { kind: "library"; file: LibraryFileView };

/** The expiry choices an audience may pick: within the platform maximum, never only internal. */
export function expiryChoices(audience: Audience, maxExpiryDays: number): ShareExpiry[] {
  return SHARE_EXPIRIES.filter((d) => (d === null ? audience === "internal" : d <= maxExpiryDays));
}

/** The default expiry (spec §2): external 7 days (or the longest allowed below it), internal never. */
function defaultExpiry(audience: Audience, maxExpiryDays: number): ShareExpiry {
  if (audience === "internal") return null;
  const days = expiryChoices("external", maxExpiryDays).filter((d) => d !== null && d <= 7);
  return days[days.length - 1] ?? expiryChoices("external", maxExpiryDays)[0] ?? 1;
}

const expiryValue = (d: ShareExpiry) => (d === null ? "never" : String(d));
const parseExpiry = (v: string): ShareExpiry => (v === "never" ? null : (Number(v) as 1 | 7 | 30));

/**
 * The Share dialog of a file in the right panel or on the Files page (file sharing design §5, file
 * library spec §6): who can open the link
 * (organization members, or anyone with it when external sharing is allowed; otherwise disabled
 * with the reason) and when it expires (choices bounded by the platform maximum), then the link
 * with Copy. Below, the file's active links (Copy, Update to latest when a newer version exists,
 * Revoke) and recent ones (Revoke on a suspended one, which may come back). The link is the
 * kernel's absolute `url` (the deployment's public URL), else `/s/<code>` on this origin.
 */
export function ShareDialog({
  orgId,
  target,
  open,
  onOpenChange,
}: {
  orgId: string;
  target: ShareTarget;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { file } = target;
  // A library file's shares name no conversation; refresh and revoke invalidate by each share's
  // own conversation (a library file lists the shares made from a conversation too)
  const conversationId = target.kind === "conversation" ? target.conversationId : null;
  const t = useTranslations("shares.dialog");
  const share = useShareCapability();
  const tc = useTranslations("common");
  const toast = useToast();
  const timeZone = useTimeZone();
  const errorMessage = useErrorMessage();
  const q = useQuery({
    ...(conversationId === null
      ? libraryFileSharesQuery(orgId, file.id)
      : fileSharesQuery(orgId, conversationId, file.id)),
    enabled: open,
  });
  const [audience, setAudience] = useState<Audience>("internal");
  const [expiry, setExpiry] = useState<ShareExpiry>(null);
  const [created, setCreated] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Both hooks are called (hook order is fixed); the target picks which one creates.
  const createInConversation = useCreateShare(orgId, conversationId ?? "", file.id);
  const createInLibrary = useCreateLibraryShare(orgId, file.id);
  const create = conversationId === null ? createInLibrary : createInConversation;
  const refresh = useRefreshShare(orgId);
  const revoke = useRevokeShare(orgId);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  // The deployment's public URL when the kernel knows it, else this page's origin.
  const link = (s: ShareView) => shareUrl(s, origin);
  const policy = q.data?.policy;
  const shares = q.data?.shares ?? [];

  const close = (next: boolean) => {
    if (!next) {
      // A reopened dialog starts over (the active links stay listed below).
      setCreated(null);
      setError(null);
      setAudience("internal");
      setExpiry(null);
    }
    onOpenChange(next);
  };
  const fail = (e: Parameters<typeof errorMessage>[0]) => setError(errorMessage(e));
  const submit = () => {
    if (create.isPending || created !== null) return;
    setError(null);
    create.mutate(
      { audience, expiresInDays: expiry },
      { onSuccess: ({ share }) => setCreated(share), onError: fail },
    );
  };
  const copy = async (s: ShareView) => {
    try {
      const done = await shareOrCopy(
        { url: link(s) },
        {
          share,
          webShare: browserShare(),
          copy: (text) => navigator.clipboard.writeText(text),
        },
      );
      if (done === "copied") toast.success(t("copied"));
    } catch {
      // No usable clipboard: the link stays readable in the row's meta line.
    }
  };

  const externalReason =
    policy?.external === "platform_denied"
      ? t("externalOffPlatform")
      : policy?.external === "org_off"
        ? t("externalOffOrg")
        : null;
  const expiryLabel = (d: ShareExpiry) => (d === null ? t("never") : t(`days${d}`));
  const audienceLabel = (a: Audience) => (a === "internal" ? t("internal") : t("external"));
  const meta = (s: ShareView) =>
    [
      link(s),
      s.expiresAt === null
        ? t("noExpiry")
        : t("expiresOn", { date: formatDateTime(s.expiresAt, "full", timeZone) }),
    ].join(" · ");
  const busy = refresh.isPending || revoke.isPending;
  const live = shares.filter((s) => s.state === "live");
  const recent = shares.filter((s) => s.state !== "live");

  let body: ReactNode;
  if (policy === undefined) {
    body =
      q.error !== null ? (
        <FormError message={errorMessage(q.error)} />
      ) : (
        <Text tone="muted">{tc("loading")}</Text>
      );
  } else {
    body = (
      <Stack gap={16}>
        <Field label={t("audience")}>
          <RadioGroup
            label={t("audience")}
            value={audience}
            onChange={(v) => {
              const a = v as Audience;
              setAudience(a);
              setExpiry(defaultExpiry(a, policy.maxExpiryDays));
            }}
            options={[
              { value: "internal", label: t("internal"), description: t("internalHint") },
              {
                value: "external",
                label: t("external"),
                description: externalReason ?? t("externalHint"),
                ...(externalReason !== null ? { disabled: true } : {}),
              },
            ]}
          />
        </Field>
        <Field label={t("expiry")} help={t("snapshot")}>
          <Select
            value={expiryValue(expiry)}
            onChange={(e) => setExpiry(parseExpiry(e.target.value))}
            options={expiryChoices(audience, policy.maxExpiryDays).map((d) => ({
              value: expiryValue(d),
              label: expiryLabel(d),
            }))}
          />
        </Field>
        {error !== null && <FormError message={error} />}
        {created !== null && <CopyField label={t("link")} value={link(created)} />}
        {live.length > 0 && (
          <Subsection title={t("live")} count={live.length} variant="divided">
            <ItemList
              label={t("live")}
              rows={live.map((s) => ({
                id: s.id,
                title: audienceLabel(s.audience),
                meta: meta(s),
                actions: (
                  <>
                    <Button density="dense" onClick={() => void copy(s)}>
                      {t("copy")}
                    </Button>
                    {s.newerVersion && (
                      <Button
                        density="dense"
                        disabled={busy}
                        onClick={() =>
                          refresh.mutate(
                            { shareId: s.id, conversationId: s.conversationId ?? conversationId },
                            { onSuccess: () => toast.success(t("updated")), onError: fail },
                          )
                        }
                      >
                        {t("updateToLatest")}
                      </Button>
                    )}
                    <Button
                      density="dense"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        revoke.mutate(
                          { shareId: s.id, conversationId: s.conversationId ?? conversationId },
                          { onError: fail },
                        )
                      }
                    >
                      {t("revoke")}
                    </Button>
                  </>
                ),
              }))}
            />
          </Subsection>
        )}
        {recent.length > 0 && (
          <Subsection title={t("recent")} count={recent.length} variant="divided">
            <ItemList
              label={t("recent")}
              rows={recent.map((s) => ({
                id: s.id,
                title: audienceLabel(s.audience),
                meta: meta(s),
                status: { label: t(s.state as "revoked" | "expired" | "suspended") },
                // A suspended link revives when the external switch comes back on: it can still
                // be revoked.
                ...(s.state === "suspended" && {
                  actions: (
                    <Button
                      density="dense"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        revoke.mutate(
                          { shareId: s.id, conversationId: s.conversationId ?? conversationId },
                          { onError: fail },
                        )
                      }
                    >
                      {t("revoke")}
                    </Button>
                  ),
                }),
              }))}
            />
          </Subsection>
        )}
      </Stack>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size={640}
      title={t("title", { name: file.name })}
      footer={
        // Once the link exists, Done replaces Create: a second click never makes a duplicate.
        created !== null ? (
          <Button variant="primary" onClick={() => close(false)}>
            {t("done")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t("done")}
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={policy === undefined}
              onClick={submit}
            >
              {t("create")}
            </Button>
          </>
        )
      }
    >
      {body}
    </Dialog>
  );
}
