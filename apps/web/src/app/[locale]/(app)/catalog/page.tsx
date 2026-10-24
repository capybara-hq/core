"use client";

import { type Column, DataTable, ListPage, RadioGroup, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  CatalogInstallAction,
  useOrgItemStatus,
} from "../../../../components/CatalogInstallAction";
import { useKindLabel } from "../../../../components/CatalogParts";
import { OrgGate } from "../../../../components/OrgGate";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import {
  displayNameOf,
  listOrgCatalog,
  type OrgCatalogItem,
  PACKAGE_KINDS,
  type PackageKind,
} from "../../../../lib/catalog";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/[locale]/catalog`: the catalog items available to this org (ListPage, members and up). Columns:
 * name, kind, summary, status, action (install / request by `installable`, see
 * CatalogInstallAction); the Rail filters by kind. A row opens the detail page.
 */
export default function CatalogPage() {
  return <OrgGate>{(orgId) => <Catalog key={orgId} orgId={orgId} />}</OrgGate>;
}

function Catalog({ orgId }: { orgId: string }) {
  const t = useTranslations("catalog.org");
  const locale = useLocale();
  const router = useRouter();
  const kindLabel = useKindLabel();
  const status = useOrgItemStatus();
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const { state, reload } = useLoad(() => listOrgCatalog(orgId), [orgId]);
  const [kind, setKind] = useState<PackageKind | "">("");
  const all = state.kind === "ready" ? state.data.items : [];
  const rows = all.filter((i) => kind === "" || i.kind === kind);

  const columns: Column<OrgCatalogItem>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (i) => (
        <Stack gap={0}>
          <Text>{displayNameOf(i, locale)}</Text>
          <Text variant="small" tone="muted">
            {i.publisher}
          </Text>
        </Stack>
      ),
    },
    { key: "kind", header: t("columns.kind"), cell: (i) => kindLabel(i.kind) },
    {
      key: "description",
      header: t("columns.description"),
      tone: "muted",
      cell: (i) => i.description,
    },
    { key: "status", header: t("columns.status"), cell: (i) => status(i) },
    {
      key: "action",
      header: "",
      // 操作按钮不触发打开整行
      cell: (i) => (
        <div data-no-open="">
          <CatalogInstallAction orgId={orgId} item={i} admin={admin} onChanged={reload} />
        </div>
      ),
    },
  ];

  return (
    <ListPage
      header={{ title: t("title"), count: String(all.length) }}
      rail={
        <RadioGroup
          label={t("filters.kind")}
          value={kind}
          onChange={(v) => setKind(v as PackageKind | "")}
          options={[
            { value: "", label: t("filters.allKinds") },
            ...PACKAGE_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
          ]}
        />
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.name}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{ title: t("empty") }}
          {...(all.length > 0 && {
            noResults: { description: t("noResults"), onClear: () => setKind("") },
          })}
          onOpen={(i) => router.push(`/catalog/${i.id}`)}
        />
      </Stack>
    </ListPage>
  );
}
