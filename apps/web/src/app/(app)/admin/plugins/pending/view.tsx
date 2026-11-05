"use client";

import {
  Button,
  Dialog,
  Field,
  KeyValue,
  ListPage,
  ObjectRow,
  Stack,
  Text,
  Textarea,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { useComponentsLabel, usePluginsHead } from "../../../../../components/PluginsHead";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import {
  type CatalogItem,
  type CatalogRequest,
  confirmPending,
  decideDeploymentRequest,
  declaredPermissions,
  displayNameOf,
  importPageHref,
  requesterOf,
  requestSubject,
  requestVersion,
} from "../../../../../lib/catalog";
import {
  catalogItemQuery,
  deploymentRequestsQuery,
  pendingPluginsQuery,
  stagedImportQuery,
} from "../../../../../lib/query/admin";
import { pluginScopeChangeKeys } from "../../../../../lib/query/catalog";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { keys } from "../../../../../lib/query/keys";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * `/admin/plugins/pending`: what waits for a super admin (ListPage, tab 待确认; spec §4,
 * §5.1, Ruling I). First the plugins whose extension permissions are not confirmed (a built-in
 * plugin keeps running meanwhile): 审阅权限 opens the permission set, and confirming sends the
 * item's `permissionsHash` (which also installs an extension that was never deployed). Then the
 * organizations' requests (`access`: use a plugin shown to them; `import`: bring in a marketplace
 * entry): 批准 takes effect at once, except an `import` request, whose approval stages the entry
 * and opens its import review (the scope defaults to the requesting org there); 拒绝 asks for an
 * optional reason the requester sees. From the query cache (the layout prefetched both reads on a
 * first load); the requests are a section of the page.
 */
export default function PendingView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <PendingRead orgId={gate.me.currentOrgId} />;
}

function PendingRead({ orgId }: { orgId: string | null }) {
  const scope = usePagePath("admin");
  const head = usePluginsHead("pending");
  const read = usePageQuery(pendingPluginsQuery());
  const rq = deploymentRequestsQuery();
  const requests = useQuery({ ...rq, retryOnMount: retryOnMountOf(rq.queryKey) });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading" || (requests.data === undefined && requests.isPending)) {
    return (
      <ListPage
        header={{
          ...head,
          path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: "pending" }],
        }}
        variant="objects"
        loading
      />
    );
  }
  return <Pending items={read.data.items} requests={requests.data?.requests ?? []} orgId={orgId} />;
}

function Pending({
  items,
  requests,
  orgId,
}: {
  items: CatalogItem[];
  requests: CatalogRequest[];
  orgId: string | null;
}) {
  const scope = usePagePath("admin");
  const head = usePluginsHead("pending");
  const t = useTranslations("catalog.admin.pending");
  const ta = useTranslations("catalog.admin");
  const componentsLabel = useComponentsLabel();
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const [reviewing, setReviewing] = useState<CatalogItem | null>(null);
  const [rejecting, setRejecting] = useState<CatalogRequest | null>(null);
  const [busy, setBusy] = useState<string>();
  // A decision ends the request (an approval may grant the plugin to the org): the requests, the
  // catalog and the overview's count are read again.
  const decide = useAppMutation({
    fn: (v: { id: string; approve: boolean; reason?: string }) =>
      decideDeploymentRequest(v.id, {
        approve: v.approve,
        ...(v.reason !== undefined && v.reason !== "" ? { reason: v.reason } : {}),
      }),
    invalidates: () => [keys.deployment().catalogRequests(), ...pluginScopeChangeKeys(orgId)],
    onSuccess: (r) => {
      if (r.import) qc.setQueryData(stagedImportQuery(r.import.stagingId).queryKey, r.import);
    },
  });

  const approve = async (r: CatalogRequest) => {
    setBusy(r.id);
    try {
      const res = await decide.mutateAsync({ id: r.id, approve: true });
      if (res.import) router.push(importPageHref(res.import.stagingId));
      else toast.success(t("approved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const total = items.length + requests.length;
  return (
    <>
      <ListPage
        header={{
          ...head,
          path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: "pending" }],
        }}
        variant="objects"
        listLabel={t("listLabel")}
        {...(total === 0 ? { empty: { text: t("empty") } } : {})}
      >
        {items.map((i) => {
          const name = displayNameOf(i, locale);
          return (
            <ObjectRow
              key={i.id}
              mark={{ text: name, tone: "warn" }}
              name={name}
              href={`/admin/plugins/${encodeURIComponent(i.id)}`}
              chips={i.builtin ? [{ label: ta("chips.builtin") }] : []}
              description={i.builtin ? t("builtinDescription") : t("permissionsDescription")}
              meta={[versionLabel(i.latestVersion), i.name, componentsLabel(i.componentCounts)]}
              state={{ label: t("waiting"), tone: "warn" }}
              action={{ label: t("review"), onSelect: () => setReviewing(i) }}
            />
          );
        })}
        {requests.map((r) => {
          const subject = displayNameOf(requestSubject(r), locale);
          const version = requestVersion(r);
          return (
            <ObjectRow
              key={r.id}
              mark={{ text: r.orgName }}
              name={`${r.orgName} · ${subject}`}
              {...(requestSubject(r).id !== null
                ? { href: `/admin/plugins/${encodeURIComponent(requestSubject(r).id ?? "")}` }
                : {})}
              chips={[{ label: t(`kind.${r.kind}`) }]}
              {...(r.note !== "" ? { description: r.note } : {})}
              meta={[
                t("requester", { name: requesterOf(r) }),
                ...(version !== null ? [versionLabel(version)] : []),
              ]}
              state={{ label: t("waiting"), tone: "warn" }}
              action={{
                label: t("approve"),
                onSelect: () => {
                  if (busy === undefined) void approve(r);
                },
              }}
              menu={[{ label: t("reject"), onSelect: () => setRejecting(r) }]}
            />
          );
        })}
      </ListPage>
      {reviewing !== null && (
        <ConfirmPermissionsDialog
          item={reviewing}
          orgId={orgId}
          onClose={() => setReviewing(null)}
        />
      )}
      {rejecting !== null && (
        <RejectDialog
          request={rejecting}
          onReject={async (reason) => {
            await decide.mutateAsync({ id: rejecting.id, approve: false, reason });
            toast.success(t("rejected"));
            setRejecting(null);
          }}
          onClose={() => setRejecting(null)}
        />
      )}
    </>
  );
}

/**
 * 审阅权限: the permission set the latest version's extension declares, and the confirmation
 * (with the item's `permissionsHash`; a set changed meanwhile is 409 `extension.approval_stale`).
 */
function ConfirmPermissionsDialog({
  item,
  orgId,
  onClose,
}: {
  item: CatalogItem;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("catalog.admin.pending");
  const tc = useTranslations("catalog.components");
  const tp = useTranslations("extensions");
  const tc2 = useTranslations("catalog.admin.scopeDialog");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const name = displayNameOf(item, locale);
  const dq = catalogItemQuery(item.id);
  const detail = useQuery({ ...dq, retryOnMount: retryOnMountOf(dq.queryKey) }).data;
  const latest = detail?.versions.find((v) => v.version === item.latestVersion);
  const ext = latest?.manifest.extension?.manifest;
  const [error, setError] = useState<string>();
  const confirm = useAppMutation({
    fn: (hash: string) => confirmPending(item.id, { permissionsHash: hash }),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  const label = (category: string) =>
    tp.has(`category.${category}`) ? tp(`category.${category}`) : category;
  const hash = item.permissionsHash;
  const submit = async () => {
    if (hash === null) return;
    setError(undefined);
    try {
      await confirm.mutateAsync(hash);
      toast.success(t("confirmed", { name }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("confirmTitle", { name })}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc2("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={confirm.isPending}
            disabled={hash === null || confirm.isPending}
            onClick={() => void submit()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("confirmHint")}</Text>
        {ext !== undefined && (
          <Stack gap={8}>
            <Text>
              {tc("extensionVersion", { name: ext.name, version: versionLabel(ext.version) })}
            </Text>
            <KeyValue
              keyWidth="16ch"
              rows={declaredPermissions(ext).map((g) => ({
                k: label(g.category),
                v: g.items.join(", "),
              }))}
            />
          </Stack>
        )}
        {hash === null && (
          <Text variant="prose" tone="warn">
            {t("noHash")}
          </Text>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/** 拒绝: an optional reason the requester sees. */
function RejectDialog({
  request,
  onReject,
  onClose,
}: {
  request: CatalogRequest;
  onReject(reason: string): Promise<void>;
  onClose(): void;
}) {
  const t = useTranslations("catalog.admin.pending");
  const tc = useTranslations("catalog.admin.scopeDialog");
  const errorMessage = useErrorMessage();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onReject(reason.trim());
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
      title={t("rejectTitle", { org: request.orgName })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="danger" loading={busy} disabled={busy} onClick={() => void submit()}>
            {t("reject")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("reason")} help={t("reasonHelp")} optional>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
