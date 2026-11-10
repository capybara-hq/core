"use client";

import {
  Button,
  CodeBlock,
  DateTime,
  DetailPage,
  Dialog,
  FormSection,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import type { AdminConnectorDetail } from "../../../../../lib/admin-items";
import { adminConnectorQuery } from "../../../../../lib/query/admin-items";
import {
  useDeleteConnector,
  useSetConnectorStatus,
} from "../../../../../lib/query/admin-items-mutations";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * `/admin/connectors/[id]` (super admins; spec 2026-11-10-admin-agents-connectors §3.5): one
 * connector of any org, read-only. The facts (org, kind, slug, status, template, authentication
 * type and ownership, creator, times), the endpoint as the kernel's view of it (large text fields
 * as their size and sha256), and the tools with their status and default policy. Never a
 * credential, nor whether anyone has one. Actions: 停用 / 启用 and 删除 (a confirmation naming the
 * org, then back to the list). From the query cache (the layout prefetched the connector on a
 * first load).
 */
export default function AdminConnectorView({ id }: { id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminConnectorRead id={id} />;
}

function AdminConnectorRead({ id }: { id: string }) {
  const scope = usePagePath("admin");
  const read = usePageQuery(adminConnectorQuery(id));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "connectors", href: "/admin/connectors" }, { label: id }],
          title: "",
          loading: { actions: 2 },
        }}
        loading={{ facts: { rows: 8, keyWidth: "10ch", columns: 2 }, blocks: 2 }}
      />
    );
  }
  return <AdminConnector connector={read.data} />;
}

function AdminConnector({ connector }: { connector: AdminConnectorDetail }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminItems.connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [deleting, setDeleting] = useState(false);
  const setStatus = useSetConnectorStatus({
    onSuccess: () =>
      toast.success(
        t(connector.status === "active" ? "toggle.disabled" : "toggle.enabled", {
          name: connector.name,
        }),
      ),
  });
  const toggle = connector.status === "active" ? "disable" : "enable";
  return (
    <>
      <DetailPage
        header={{
          path: [
            ...scope,
            { label: "connectors", href: "/admin/connectors" },
            { label: connector.name },
          ],
          title: connector.name,
          actions: [
            {
              label: t(`actions.${toggle}`),
              variant: "default",
              onSelect: () =>
                setStatus.mutate({
                  connectorId: connector.id,
                  orgId: connector.orgId,
                  status: connector.status === "active" ? "disabled" : "active",
                }),
            },
            { label: t("actions.delete"), variant: "default", onSelect: () => setDeleting(true) },
          ],
        }}
        facts={<ConnectorFacts connector={connector} />}
      >
        <Stack gap={16}>
          {setStatus.error && <FormError message={errorMessage(setStatus.error)} />}
          <ConnectorSections connector={connector} />
        </Stack>
      </DetailPage>
      {deleting && <DeleteDialog connector={connector} onClose={() => setDeleting(false)} />}
    </>
  );
}

/** The connector's facts: a KeyValue in two columns under the head. */
function ConnectorFacts({ connector }: { connector: AdminConnectorDetail }) {
  const t = useTranslations("adminItems.connectors");
  const td = useTranslations("adminItems.connectors.detail");
  const authType = connector.auth.type;
  const authLabel = td.has(`auth.${authType}`) ? td(`auth.${authType}`) : authType;
  const from =
    connector.platformTemplateId !== null
      ? t("fromPlatform")
      : connector.catalogItemId !== null
        ? t("fromCatalog")
        : "—";
  return (
    <KeyValue
      keyWidth="10ch"
      columns={2}
      rows={[
        { k: td("facts.org"), v: connector.orgName },
        { k: td("facts.kind"), v: connector.connector },
        { k: td("facts.slug"), v: connector.slug },
        {
          k: td("facts.status"),
          v: (
            <StatusMark
              status={connector.status === "active" ? "success" : "cancelled"}
              label={t(`status.${connector.status}`)}
            />
          ),
        },
        { k: td("facts.from"), v: from },
        { k: td("facts.auth"), v: authLabel },
        ...(connector.auth.ownership !== null
          ? [{ k: td("facts.ownership"), v: td(`ownership.${connector.auth.ownership}`) }]
          : []),
        { k: td("facts.createdBy"), v: connector.createdByName },
        {
          k: td("facts.synced"),
          v:
            connector.toolsSyncedAt === null ? (
              t("never")
            ) : (
              <DateTime value={connector.toolsSyncedAt} />
            ),
        },
        { k: td("facts.updated"), v: <DateTime value={connector.updatedAt} /> },
        { k: td("facts.created"), v: <DateTime value={connector.createdAt} /> },
      ]}
    />
  );
}

/** The read-only sections: the endpoint and the tools. */
function ConnectorSections({ connector }: { connector: AdminConnectorDetail }) {
  const t = useTranslations("adminItems.connectors.detail");
  const endpoint = connector.endpoint;
  const empty =
    endpoint === null ||
    endpoint === undefined ||
    (typeof endpoint === "object" && Object.keys(endpoint).length === 0);
  return (
    <Stack gap={16}>
      <FormSection id="endpoint" title={t("sections.endpoint")}>
        {empty ? (
          <Text tone="faint">{t("endpointEmpty")}</Text>
        ) : (
          <CodeBlock language="json" text={JSON.stringify(endpoint, null, 2)} />
        )}
      </FormSection>
      <FormSection id="tools" title={t("sections.tools")} flush>
        <ItemList label={t("sections.tools")} inset="flush" empty={t("toolsNone")}>
          {connector.tools.map((x) => (
            <ItemListItem
              key={x.name}
              title={x.title ?? x.name}
              {...(x.title !== null && x.title !== x.name ? { code: x.name } : {})}
              marks={
                <Text tone="muted">
                  {t(`toolStatus.${x.status}`)} · {t(`policy.${x.defaultPolicy}`)}
                </Text>
              }
            />
          ))}
        </ItemList>
      </FormSection>
    </Stack>
  );
}

/** 删除: a confirmation naming the org; then back to the list. */
function DeleteDialog({
  connector,
  onClose,
}: {
  connector: AdminConnectorDetail;
  onClose(): void;
}) {
  const t = useTranslations("adminItems.connectors.delete");
  const tc = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const remove = useDeleteConnector({
    onSuccess: () => {
      toast.success(t("done", { name: connector.name }));
      router.push("/admin/connectors");
    },
  });
  const error = remove.error ? errorMessage(remove.error) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title", { name: connector.name })}
      danger
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={remove.isPending}
            onClick={() => remove.mutate({ connectorId: connector.id, orgId: connector.orgId })}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t("hint", { org: connector.orgName })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
