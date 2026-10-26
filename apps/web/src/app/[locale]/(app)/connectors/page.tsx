"use client";

import { Button, type Column, DataTable, ListPage, StatusMark } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { OrgGate } from "../../../../components/OrgGate";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import {
  type ConnectorSummary,
  canManageConnectors,
  listConnectors,
} from "../../../../lib/connectors";
import { useLoad } from "../../../../lib/use-load";

/** `/[locale]/connectors`：当前组织安装的连接器（ListPage + DataTable），点击行进入详情。 */
export default function AppsPage() {
  return <OrgGate>{(orgId) => <Connectors orgId={orgId} />}</OrgGate>;
}

function Connectors({ orgId }: { orgId: string }) {
  const t = useTranslations("connectors");
  const router = useRouter();
  const { me } = useSession();
  const manage = canManageConnectors(me);
  const { state, reload } = useLoad(() => listConnectors(orgId).then((r) => r.connectors), [orgId]);
  const open = (a: ConnectorSummary) => router.push(`/connectors/${encodeURIComponent(a.id)}`);

  const columns: Column<ConnectorSummary>[] = [
    { key: "name", header: t("columns.name"), cell: (a) => a.name },
    { key: "slug", header: t("columns.slug"), tone: "muted", cell: (a) => a.slug },
    {
      key: "auth",
      header: t("columns.auth"),
      tone: "muted",
      cell: (a) => t(`auth.${a.auth.type}`),
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (a) =>
        a.status === "active" ? (
          <StatusMark status="success" label={t("status.active")} />
        ) : (
          <StatusMark status="cancelled" label={t("status.disabled")} />
        ),
    },
  ];

  return (
    <ListPage
      header={{
        title: t("title"),
        count: state.kind === "ready" ? String(state.data.length) : undefined,
        actions: [
          ...(manage
            ? [{ label: t("new"), variant: "primary" as const, href: "/connectors/install" }]
            : []),
          { label: t("myConnections"), variant: "default" as const, href: "/settings/connections" },
        ],
      }}
    >
      <DataTable<ConnectorSummary>
        label={t("title")}
        columns={columns}
        rows={state.kind === "ready" ? state.data : []}
        rowKey={(a) => a.id}
        rowLabel={(a) => a.name}
        onOpen={open}
        state={state.kind === "ready" ? "ready" : state.kind}
        {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
        empty={{
          title: t("empty"),
          hint: t("emptyHint"),
          ...(manage
            ? {
                action: (
                  <Button onClick={() => router.push("/connectors/install")}>{t("new")}</Button>
                ),
              }
            : {}),
        }}
      />
    </ListPage>
  );
}
