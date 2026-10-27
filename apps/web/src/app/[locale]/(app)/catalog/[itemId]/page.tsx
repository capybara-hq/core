"use client";

import { Card, DetailPage, KeyValue, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  CatalogInstallAction,
  useOrgItemStatus,
} from "../../../../../components/CatalogInstallAction";
import { CatalogIcon, ComponentSection } from "../../../../../components/CatalogParts";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import { ApiClientError } from "../../../../../lib/api";
import {
  agentTemplateNameOf,
  displayNameOf,
  endpointLeaves,
  getOrgCatalogItem,
  orgIconUrl,
  showValue,
  skillNameOf,
} from "../../../../../lib/catalog";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/catalog/[itemId]`: a plugin in the catalog from the org's view (DetailPage). Summary,
 * the latest version's components (its extension, skills, connector templates with endpoint and
 * auth, dependencies installed with it); actions follow `installable` (CatalogInstallAction).
 * Inspector: the icon (shown as `<img>` through the kernel route) and basic facts.
 */
export default function OrgCatalogItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return <OrgGate>{(orgId) => <ItemDetail key={orgId} orgId={orgId} itemId={itemId} />}</OrgGate>;
}

function ItemDetail({ orgId, itemId }: { orgId: string; itemId: string }) {
  const t = useTranslations("catalog.org");
  const tr = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  const locale = useLocale();
  const status = useOrgItemStatus();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const { state, reload } = useLoad(() => getOrgCatalogItem(orgId, itemId), [orgId, itemId]);
  const detail = state.kind === "ready" ? state.data : undefined;
  const item = detail?.item;

  return (
    <DetailPage
      header={{
        breadcrumb: [{ label: t("title"), href: "/catalog" }],
        title: item ? displayNameOf(item, locale) : t("title"),
        ...(item && { count: item.latestVersion }),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: [{ id: "overview", label: t("detail.tabs.overview") }],
        value: "overview",
        onChange: () => {},
      }}
      {...(detail &&
        item && {
          inspectorTitle: item.name,
          inspector: (
            <Stack gap={12}>
              {detail.hasIcon && <CatalogIcon src={orgIconUrl(orgId, item.id)} name={item.name} />}
              <KeyValue
                keyWidth="10ch"
                rows={[
                  { k: t("detail.fields.publisher"), v: item.publisher || "—" },
                  { k: t("detail.fields.version"), v: item.latestVersion },
                  { k: t("detail.fields.status"), v: status(item) },
                ]}
              />
            </Stack>
          ),
        })}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError
          message={
            state.code === "catalog.item_not_found"
              ? t("detail.notFound")
              : errorMessage(new ApiClientError(0, state.code, state.code))
          }
        />
      ) : detail && item ? (
        <Stack gap={16}>
          {item.description !== "" && <Text>{item.description}</Text>}
          <CatalogInstallAction
            orgId={orgId}
            item={item}
            admin={canUpdateOrg(me)}
            onChanged={reload}
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
                  {c.description !== "" && <Text tone="muted">{c.description}</Text>}
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
      ) : null}
    </DetailPage>
  );
}
