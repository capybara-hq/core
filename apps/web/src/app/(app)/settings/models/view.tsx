"use client";

import {
  EmptyState,
  ErrorDetail,
  FormSection,
  LinkButton,
  type PageHeaderProps,
  SettingsPage,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import {
  ModelCatalog,
  ModelProvidersLoading,
  ProviderSelect,
} from "../../../../components/ModelCatalog";
import { useModelDisabling } from "../../../../components/ModelDisabling";
import { NoAccess } from "../../../../components/NoAccess";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ProviderModels } from "../../../../lib/agents";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type AdminProvider,
  type ModelDisableChange,
  type ModelsTab,
  type PurposeTarget,
  type PurposeView,
  parseModelsTab,
  putOrgPurpose,
  selectedProvider,
} from "../../../../lib/models";
import { orgExtensionsQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { allModelsQuery } from "../../../../lib/query/conversation";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { modelsCatalogQuery, orgPurposesQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useUrlParam, useUrlTab } from "../../../../lib/url-tab";
import NotFound from "../../not-found";

/**
 * `/settings/models`：模型（组织管理员，SettingsPage），two tabs in the head, kept in the address:
 * - 模型 (the bare page): the org's catalog, the providers beside the open one's models
 *   (`?provider=<plugin>`, the first by default), one table per kind with the org's switches (an
 *   org admin turns off models among the ones the platform left on); under the provider's name how
 *   it is configured here with a link to its config; a provider that cannot list its models here
 *   shows its error in the detail;
 * - 用途默认 (`?tab=purposes`): each purpose shows the deployment default the super admins set and
 *   the org may override it (a model and its params) or restore the default; `eval` without an
 *   effective mapping says the evals cannot use a judge (the eval wizard links here).
 * From the query cache (the layout prefetched it on a first load, for either tab): the org's
 * purposes, the models they can map to and the catalog; a saved purpose is written into the
 * cached purposes.
 */
export default function OrgModelsView({
  tab = "models",
  provider = "",
}: {
  tab?: ModelsTab;
  provider?: string;
}) {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrgModels orgId={ws.orgId} initialTab={tab} initialProvider={provider} />;
}

/**
 * The purposes while they load, as PurposeEditor draws them: the kernel's six (eval, title, web
 * extraction and the three sub-agent tiers), each a row with its one hint (what happens while it
 * is unset) over the model select (its default option names the deployment default).
 */
const purposeRow = (lines: number) => ({
  lines,
  lineSize: "small" as const,
  field: { control: "select" as const },
});
const LOADING_PURPOSES = [1, 1, 1, 1, 1, 1].map(purposeRow);

type Header = {
  path: { label: string; href?: string }[];
  title: string;
  tabs: NonNullable<PageHeaderProps["tabs"]>;
  activeTab: ModelsTab;
};

function OrgModels({
  orgId,
  initialTab,
  initialProvider,
}: {
  orgId: string;
  initialTab: ModelsTab;
  initialProvider: string;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("models");
  const nav = useOrgSettingsNav();
  const purposes = usePageQuery(orgPurposesQuery(orgId));
  const models = usePageQuery(allModelsQuery(orgId));
  const catalog = usePageQuery(modelsCatalogQuery(orgId));
  const [tab, setTab] = useUrlTab(initialTab, parseModelsTab, "models");
  const [provider, setProvider] = useUrlParam("provider", initialProvider, (r) => r ?? "", "");
  const header: Header = {
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "models" }],
    title: t("org.pageTitle"),
    tabs: (["models", "purposes"] as const).map((id) => ({
      id,
      label: t(`tabs.${id}`),
      onSelect: () => setTab(id),
    })),
    activeTab: tab,
  };
  if (purposes.kind === "notFound" || models.kind === "notFound" || catalog.kind === "notFound") {
    return <NotFound />;
  }
  if (purposes.kind === "error") return <ErrorFrame reset={purposes.retry} />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (catalog.kind === "error") return <ErrorFrame reset={catalog.retry} />;
  if (purposes.kind === "loading" || models.kind === "loading" || catalog.kind === "loading") {
    return tab === "models" ? (
      // The picker's slot over the loading chat table (the provider names come with the data)
      <SettingsPage header={header} nav={nav} activeNav="models">
        <ModelProvidersLoading
          picker
          columns={[
            ...(["model", "capabilities", "context"] as const).map((key) => ({
              key,
              header: t(`admin.columns.${key}`),
            })),
            { key: "enabled", header: t("catalog.enabled") },
          ]}
        />
      </SettingsPage>
    ) : (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="models"
        loading={{
          sections: [
            { items: LOADING_PURPOSES, title: t("org.title"), description: t("org.description") },
          ],
        }}
      />
    );
  }
  return (
    <ModelsBody
      orgId={orgId}
      header={header}
      provider={provider}
      onProvider={setProvider}
      purposes={purposes.data.purposes}
      providers={models.data.providers}
      catalog={catalog.data.providers}
    />
  );
}

function ModelsBody({
  orgId,
  header,
  provider,
  onProvider,
  purposes,
  providers,
  catalog,
}: {
  orgId: string;
  header: Header;
  provider: string;
  onProvider(plugin: string): void;
  purposes: PurposeView[];
  providers: ProviderModels[];
  catalog: AdminProvider[];
}) {
  const t = useTranslations("models");
  const locale = useLocale();
  const nav = useOrgSettingsNav();
  const qc = useQueryClient();
  const disabling = useModelDisabling({
    scope: { orgId },
    purposes,
    invalidates: () => [keys.org(orgId).models(), keys.org(orgId).modelsCatalog()],
  });
  const key = orgPurposesQuery(orgId).queryKey;
  // The answer is the saved purpose: it replaces that purpose in the cache (a functional update:
  // the ActionRow saves several purposes at once).
  const put = useAppMutation({
    fn: (v: { purpose: string; target: PurposeTarget | null }) =>
      putOrgPurpose(orgId, v.purpose, v.target),
    invalidates: () => [],
  });
  const replace = (v: PurposeView) =>
    qc.setQueryData<{ purposes: PurposeView[] }>(key, (d) =>
      d === undefined
        ? d
        : { ...d, purposes: d.purposes.map((p) => (p.purpose === v.purpose ? v : p)) },
    );
  const { list, actionRow } = usePurposeDrafts({
    purposes,
    providers,
    scope: "org",
    save: (purpose, target) => put.mutateAsync({ purpose, target }).then((r) => r.purpose),
    onSaved: replace,
  });

  if (header.activeTab === "purposes") {
    // The drafts live in this component: a switch to 模型 and back keeps them
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="models"
        {...(actionRow !== undefined ? { actionRow } : {})}
      >
        <FormSection id="purposes" title={t("org.title")} description={t("org.description")} flush>
          {list(t("org.title"))}
        </FormSection>
      </SettingsPage>
    );
  }

  const open = selectedProvider(catalog, provider);
  const nameOf = (p: AdminProvider) =>
    extensionLabel({ name: p.provider, displayName: p.displayName }, labelLocale(locale));
  return (
    <SettingsPage header={header} nav={nav} activeNav="models">
      {disabling.notice}
      {open === undefined ? (
        <EmptyState
          text={t("org.noProviders")}
          action={
            <LinkButton href="/plugins" variant="primary">
              {t("org.toPlugins")}
            </LinkButton>
          }
        />
      ) : (
        <Stack gap={16}>
          <Text variant="prose" tone="muted">
            {t("catalog.orgDescription")}
          </Text>
          {/* No providers column here: beside the settings nav it would squeeze the tables, so
              a select above the detail picks the provider */}
          <OrgProvider
            key={open.plugin}
            orgId={orgId}
            provider={open}
            name={nameOf(open)}
            pending={disabling.pending}
            onChange={disabling.change}
            picker={
              <ProviderSelect
                providers={catalog.map((p) => ({
                  plugin: p.plugin,
                  name: nameOf(p),
                  ...(p.status === "ok" ? { count: p.models.length } : {}),
                  failed: p.status !== "ok",
                }))}
                selected={open.plugin}
                onSelect={onProvider}
              />
            }
          />
        </Stack>
      )}
    </SettingsPage>
  );
}

/**
 * The open provider of the org's catalog: its models with the org's switches, and under its name
 * how it is configured here (跟随平台 / 本组织配置, from the extension's `overrideState`) with a
 * link to the extension's config. A provider that cannot list its models here shows its error
 * instead.
 */
function OrgProvider({
  orgId,
  provider: p,
  name,
  pending,
  onChange,
  picker,
}: {
  orgId: string;
  provider: AdminProvider;
  name: string;
  pending: boolean;
  picker: ReactNode;
  onChange(provider: string, change: ModelDisableChange): void;
}) {
  const t = useTranslations("models");
  const extensionsQ = orgExtensionsQuery(orgId);
  // The state line is a hint: a failed or slow read leaves it out, never blocks the models.
  const extensions = useQuery({
    ...extensionsQ,
    retryOnMount: retryOnMountOf(extensionsQ.queryKey),
  });
  const ext = extensions.data?.extensions.find((e) => e.plugin === p.plugin);
  const state =
    ext?.overrideState === "following"
      ? t("catalog.following")
      : ext?.overrideState === "copy"
        ? t("catalog.orgConfigured")
        : undefined;
  const id = p.displayName ? p.provider : undefined;
  const description =
    id !== undefined || (p.status === "ok" && state !== undefined) ? (
      <Stack direction="row" gap={8} align="center" wrap>
        {id !== undefined ? (
          <Text variant="small" tone="muted">
            {id}
          </Text>
        ) : null}
        {p.status === "ok" && state !== undefined ? (
          <>
            <Text variant="small" tone="muted">
              {state}
            </Text>
            <LinkButton href="/extensions?tab=model" density="dense">
              {t("catalog.configure")}
            </LinkButton>
          </>
        ) : null}
      </Stack>
    ) : undefined;
  return (
    <ModelCatalog
      provider={name}
      title={name}
      {...(description !== undefined ? { description } : {})}
      models={p.status === "ok" ? p.models : []}
      {...(p.status === "ok"
        ? {}
        : {
            unlisted: (
              <ErrorDetail
                summary={t("admin.providerError", { provider: name })}
                {...(p.error === undefined ? {} : { detail: p.error })}
              />
            ),
          })}
      pending={pending}
      onChange={(change) => onChange(p.provider, change)}
      picker={picker}
    />
  );
}
