"use client";

import { Card, DetailPage, KeyValue, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  CatalogInstallAction,
  useOrgItemStatus,
} from "../../../../../components/CatalogInstallAction";
import { CatalogIcon, useKindLabel } from "../../../../../components/CatalogParts";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import { ApiClientError } from "../../../../../lib/api";
import {
  displayNameOf,
  endpointLeaves,
  getOrgCatalogItem,
  orgIconUrl,
  showValue,
} from "../../../../../lib/catalog";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/catalog/[itemId]`: a catalog item from the org's view (DetailPage). Summary, the
 * connector template's endpoint and auth, a plugin's extensions and skills; actions follow
 * `installable` (CatalogInstallAction). Inspector: the icon (shown as `<img>` through the kernel
 * route) and basic facts.
 */
export default function OrgCatalogItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return <OrgGate>{(orgId) => <ItemDetail key={orgId} orgId={orgId} itemId={itemId} />}</OrgGate>;
}

function ItemDetail({ orgId, itemId }: { orgId: string; itemId: string }) {
  const t = useTranslations("catalog.org");
  const tr = useTranslations("catalog.admin.review");
  const locale = useLocale();
  const kindLabel = useKindLabel();
  const status = useOrgItemStatus();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const { state, reload } = useLoad(() => getOrgCatalogItem(orgId, itemId), [orgId, itemId]);
  const detail = state.kind === "ready" ? state.data : undefined;
  const item = detail?.item;

  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: "/catalog" },
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
                  { k: t("detail.fields.kind"), v: kindLabel(item.kind) },
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
          {detail.templates.length > 0 && (
            <Stack gap={8}>
              <Text>{t("detail.templates")}</Text>
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
                    <Text variant="small">
                      {tr("auth", { type: String(c.auth.type ?? "none") })}
                    </Text>
                  </Stack>
                </Card>
              ))}
            </Stack>
          )}
          {detail.plugins.length > 0 && (
            <Stack gap={4}>
              <Text>{t("detail.extensions")}</Text>
              {detail.plugins.map((p) => (
                <Text key={p.name} variant="small" tone="muted">
                  {`· ${p.name} ${p.range}${p.optional ? ` (${tr("optional")})` : ""}`}
                </Text>
              ))}
            </Stack>
          )}
          {detail.skills.length > 0 && (
            <Stack gap={4}>
              <Text>{t("detail.skills")}</Text>
              {detail.skills.map((s) => (
                <Text key={s} variant="small" tone="muted">
                  {`· ${s}`}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      ) : null}
    </DetailPage>
  );
}
