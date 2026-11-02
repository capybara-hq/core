"use client";

import { Card, DetailPage, KeyValue, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import {
  CatalogInstallAction,
  useOrgItemStatus,
} from "../../../../components/CatalogInstallAction";
import { CatalogIcon, ComponentSection } from "../../../../components/CatalogParts";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import {
  agentTemplateNameOf,
  displayNameOf,
  endpointLeaves,
  type OrgCatalogDetail,
  orgIconUrl,
  showValue,
  skillNameOf,
} from "../../../../lib/catalog";
import { canUpdateOrg } from "../../../../lib/org-settings";

/**
 * `/catalog/[itemId]`: a plugin in the catalog from the org's view (DetailPage). Summary,
 * the latest version's components (its extension, skills, connector templates with endpoint and
 * auth, dependencies installed with it); actions follow `installable` (CatalogInstallAction).
 * Inspector: the icon (shown as `<img>` through the kernel route) and basic facts. Read on the
 * server (`page.tsx`); an install action re-renders it there.
 */
export default function CatalogItemView({
  orgId,
  initial: detail,
}: {
  orgId: string;
  initial: OrgCatalogDetail;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org");
  const tr = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  const locale = useLocale();
  const status = useOrgItemStatus();
  const { me } = useSession();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const item = detail.item;

  return (
    <DetailPage
      header={{
        path: [
          ...scope,
          { label: "catalog", href: "/catalog" },
          { label: displayNameOf(item, locale) },
        ],
        title: displayNameOf(item, locale),
        count: versionLabel(item.latestVersion),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: [{ id: "overview", label: t("detail.tabs.overview") }],
        value: "overview",
        onChange: () => {},
      }}
      inspectorTitle={item.name}
      inspector={
        <Stack gap={12}>
          {detail.hasIcon && <CatalogIcon src={orgIconUrl(orgId, item.id)} name={item.name} />}
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.fields.publisher"), v: item.publisher || "—" },
              { k: t("detail.fields.version"), v: versionLabel(item.latestVersion) },
              { k: t("detail.fields.status"), v: status(item) },
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={16}>
        {item.description !== "" && <Text variant="prose">{item.description}</Text>}
        <CatalogInstallAction
          orgId={orgId}
          item={item}
          admin={canUpdateOrg(me)}
          onChanged={() => startTransition(() => router.refresh())}
        />
        <ComponentSection
          title={tc("extension")}
          count={detail.extension === null ? 0 : 1}
          empty={tc("extensionNone")}
        >
          <Text>{`· ${detail.extension ?? ""}`}</Text>
        </ComponentSection>
        <ComponentSection
          title={tc("skills")}
          count={detail.skills.length}
          empty={tc("skillsNone")}
        >
          {detail.skills.map((s) => (
            <Text key={s}>{`· ${skillNameOf(s)}`}</Text>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("agentTemplates")}
          count={detail.agents?.length ?? 0}
          empty={tc("agentTemplatesNone")}
        >
          {(detail.agents ?? []).map((a) => (
            <Text key={a}>{`· ${agentTemplateNameOf(a)}`}</Text>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("templates")}
          count={detail.templates.length}
          empty={tc("templatesNone")}
        >
          {detail.templates.map((c) => (
            <Card
              key={c.id}
              title={
                c.displayName
                  ? displayNameOf({ name: c.id, displayName: c.displayName }, locale)
                  : c.connector
              }
            >
              <Stack gap={8}>
                {c.description !== "" && (
                  <Text variant="prose" tone="muted">
                    {c.description}
                  </Text>
                )}
                <KeyValue
                  keyWidth="14ch"
                  rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
                />
                {c.editableEndpoint.length > 0 && (
                  <Text variant="small" tone="muted">
                    {tr("editable", { paths: c.editableEndpoint.join(", ") })}
                  </Text>
                )}
                <Text variant="small">{tr("auth", { type: String(c.auth.type ?? "none") })}</Text>
              </Stack>
            </Card>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("dependencies")}
          count={detail.dependencies.length}
          empty={tc("dependenciesNone")}
        >
          <Text variant="small" tone="muted">
            {tc("dependenciesHint")}
          </Text>
          {detail.dependencies.map((d) => (
            <Text key={d.name}>{`· ${d.name} ${d.range}`}</Text>
          ))}
        </ComponentSection>
      </Stack>
    </DetailPage>
  );
}
