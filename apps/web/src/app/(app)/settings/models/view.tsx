"use client";

import { FormSection, LinkButton, SettingsPage, Stack, Text } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { ModelCatalog } from "../../../../components/ModelCatalog";
import { useModelDisabling } from "../../../../components/ModelDisabling";
import { NoAccess } from "../../../../components/NoAccess";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ProviderModels } from "../../../../lib/agents";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type AdminProvider,
  type PurposeTarget,
  type PurposeView,
  putOrgPurpose,
} from "../../../../lib/models";
import { orgExtensionsQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { allModelsQuery } from "../../../../lib/query/conversation";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { modelsCatalogQuery, orgPurposesQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/settings/models`：模型用途（组织管理员，SettingsPage）。每个用途显示超级管理员设的部署默认，
 * 组织可以覆盖（选模型与参数）或恢复默认；`eval` 没有生效的映射时提示评测不能开评委（评测向导链到这里）。
 * From the query cache (the layout prefetched it on a first load): the org's purposes and the
 * models they can map to; a saved purpose is written into the cached purposes.
 */
export default function OrgModelsView() {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrgModels orgId={ws.orgId} />;
}

/**
 * The purposes while they load, as PurposeEditor draws them: the kernel's five (eval, title and
 * the three sub-agent tiers), each a row with its small lines (who declares it, the deployment
 * default, and a sub-agent tier's hint) over the model select.
 */
const purposeRow = (lines: number) => ({
  lines,
  lineSize: "small" as const,
  field: { control: "select" as const },
});
const LOADING_PURPOSES = [2, 2, 3, 3, 3].map(purposeRow);

function OrgModels({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("models");
  const nav = useOrgSettingsNav();
  const purposes = usePageQuery(orgPurposesQuery(orgId));
  const models = usePageQuery(allModelsQuery(orgId));
  const catalog = usePageQuery(modelsCatalogQuery(orgId));
  const header = {
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "models" }],
    title: t("org.title"),
  };
  if (purposes.kind === "notFound" || models.kind === "notFound" || catalog.kind === "notFound") {
    return <NotFound />;
  }
  if (purposes.kind === "error") return <ErrorFrame reset={purposes.retry} />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (catalog.kind === "error") return <ErrorFrame reset={catalog.retry} />;
  if (purposes.kind === "loading" || models.kind === "loading" || catalog.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="models"
        loading={{
          sections: [
            { title: t("catalog.title"), description: t("catalog.orgDescription"), fields: 2 },
            {
              items: LOADING_PURPOSES,
              title: t("org.title"),
              description: t("org.description"),
            },
          ],
        }}
      />
    );
  }
  return (
    <Purposes
      orgId={orgId}
      header={header}
      purposes={purposes.data.purposes}
      providers={models.data.providers}
      catalog={catalog.data.providers}
    />
  );
}

function Purposes({
  orgId,
  header,
  purposes,
  providers,
  catalog,
}: {
  orgId: string;
  header: { path: { label: string; href?: string }[]; title: string };
  purposes: PurposeView[];
  providers: ProviderModels[];
  catalog: AdminProvider[];
}) {
  const t = useTranslations("models");
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
  return (
    <SettingsPage
      header={{ path: header.path, title: header.title }}
      nav={nav}
      activeNav="models"
      {...(actionRow !== undefined ? { actionRow } : {})}
    >
      {disabling.notice}
      <FormSection
        id="models"
        title={t("catalog.title")}
        description={t("catalog.orgDescription")}
        flush
      >
        {catalog.map((p) => (
          <OrgProvider
            key={p.provider}
            orgId={orgId}
            provider={p}
            pending={disabling.pending}
            onChange={disabling.change}
          />
        ))}
      </FormSection>
      <FormSection id="purposes" title={t("org.title")} description={t("org.description")} flush>
        {list(t("org.title"))}
      </FormSection>
    </SettingsPage>
  );
}

/**
 * One provider of the org's catalog: its models with the org's switches, and under its name how it
 * is configured here (跟随平台 / 本组织配置, from the extension's `overrideState`) with a link to the
 * extension's config. A provider that cannot list its models here shows its error instead.
 */
function OrgProvider({
  orgId,
  provider: p,
  pending,
  onChange,
}: {
  orgId: string;
  provider: AdminProvider;
  pending: boolean;
  onChange(provider: string, previous: string[], next: string[]): void;
}) {
  const t = useTranslations("models");
  const locale = useLocale();
  const extensionsQ = orgExtensionsQuery(orgId);
  // The state line is a hint: a failed or slow read leaves it out, never blocks the models.
  const extensions = useQuery({
    ...extensionsQ,
    retryOnMount: retryOnMountOf(extensionsQ.queryKey),
  });
  const ext = extensions.data?.extensions.find((e) => e.plugin === p.plugin);
  const name = extensionLabel(
    { name: p.provider, displayName: p.displayName },
    labelLocale(locale),
  );
  const state =
    ext?.overrideState === "following"
      ? t("catalog.following")
      : ext?.overrideState === "copy"
        ? t("catalog.orgConfigured")
        : undefined;
  const id = p.displayName ? p.provider : undefined;
  const description =
    p.status === "ok" ? (
      <Stack direction="row" gap={8} align="center" wrap>
        {id !== undefined ? (
          <Text variant="small" tone="muted">
            {id}
          </Text>
        ) : null}
        {state !== undefined ? (
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
    ) : (
      <FormError
        message={t("admin.providerError", { provider: name })}
        extra={p.error === undefined ? [] : [p.error]}
      />
    );
  return (
    <ModelCatalog
      provider={name}
      title={name}
      description={description}
      models={p.status === "ok" ? p.models : []}
      failed={p.status !== "ok"}
      pending={pending}
      onChange={(next) =>
        onChange(
          p.provider,
          p.models.filter((m) => m.disabled === true).map((m) => m.id),
          next,
        )
      }
    />
  );
}
