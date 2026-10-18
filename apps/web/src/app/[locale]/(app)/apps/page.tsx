"use client";

import { Button, type Column, DataTable, ListPage, StatusMark } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { OrgGate } from "../../../../components/OrgGate";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import { type AppSummary, canManageApps, listApps } from "../../../../lib/apps";
import { useLoad } from "../../../../lib/use-load";

/** `/[locale]/apps`：当前组织安装的应用（ListPage + DataTable），点击行进入详情。 */
export default function AppsPage() {
  return <OrgGate>{(orgId) => <Apps orgId={orgId} />}</OrgGate>;
}

function Apps({ orgId }: { orgId: string }) {
  const t = useTranslations("apps");
  const router = useRouter();
  const { me } = useSession();
  const manage = canManageApps(me);
  const { state, reload } = useLoad(() => listApps(orgId).then((r) => r.apps), [orgId]);
  const open = (a: AppSummary) => router.push(`/apps/${encodeURIComponent(a.id)}`);

  const columns: Column<AppSummary>[] = [
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
            ? [{ label: t("new"), variant: "primary" as const, href: "/apps/install" }]
            : []),
          { label: t("myConnections"), variant: "default" as const, href: "/settings/connections" },
        ],
      }}
    >
      <DataTable<AppSummary>
        label={t("title")}
        framed={false}
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
            ? { action: <Button onClick={() => router.push("/apps/install")}>{t("new")}</Button> }
            : {}),
        }}
      />
    </ListPage>
  );
}
