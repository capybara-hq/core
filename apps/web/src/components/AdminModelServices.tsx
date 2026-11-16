"use client";

import {
  Button,
  FormSection,
  ItemList,
  type ItemListRow,
  LinkButton,
  Sheet,
  Stack,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { type AdminExtension, enableExtension } from "../lib/admin-extensions";
import { issueLines } from "../lib/api";
import {
  displayNameOf,
  entryDeprecated,
  groupMarketplaceEntries,
  importMarketplaceEntry,
  importPageHref,
  type MarketplaceEntry,
} from "../lib/catalog";
import { inTab } from "../lib/extension-capabilities";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import {
  adminExtensionsQuery,
  extensionChangeKeys,
  marketplaceEntriesQuery,
  stagedImportQuery,
} from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { ExtensionStatusMark } from "./AdminExtensionParts";
import { useDeploymentConfig } from "./ExtensionDeploymentConfig";
import { FormError } from "./form-error";

/** The deployment's extensions that provide models (the Models tab of `/admin/extensions`). */
export const modelServicesOf = (extensions: readonly AdminExtension[]): AdminExtension[] =>
  inTab(extensions, "model", (p) => p.permissions);

/** A marketplace entry that brings a model provider (its declared `provides:model-provider@N`). */
const providesModels = (e: MarketplaceEntry): boolean =>
  e.permissions?.keys.some((k) => k.startsWith("provides:model-provider@")) ?? false;

/**
 * The super admin's one place to set up a model service (`/admin/models`, the setup checklist's
 * model step while the platform has none): Model services, one row per model service on the
 * deployment (its icon, name linking to its extension page, state) with Configure, which opens a Sheet holding the
 * extension's deployment config (the one config form, `useDeploymentConfig`); then the
 * marketplaces' model service plugins not installed yet (those whose entry declares
 * `provides:model-provider`) with Install, which stages the plugin and opens the import review,
 * as the Marketplace tab does. The marketplace is read in the background: while it loads, or when it
 * failed, only the deployed rows show. Empty, the list says to install one from the marketplace.
 * A pointer to the whole marketplace follows the section.
 */
export function AdminModelServices({
  extensions,
  drainSeconds,
  orgId,
}: {
  /** The deployment's extensions (`adminExtensionsQuery`). */
  extensions: AdminExtension[];
  drainSeconds: number;
  /** The super admin's current org, whose cached lists a config save changes. */
  orgId: string | null;
}) {
  const t = useTranslations("models.admin");
  const ts = useTranslations("admin.extensions.status");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ message: string; extra: string[] }>();
  const services = modelServicesOf(extensions);
  const mq = marketplaceEntriesQuery("", "");
  const market = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) });
  const installed = new Set(extensions.map((p) => p.name));
  const candidates = groupMarketplaceEntries(market.data?.items ?? [])
    .map((g) => g.latest)
    .filter(
      (e) =>
        providesModels(e) &&
        e.adopted === null &&
        !installed.has(e.name) &&
        e.compatible &&
        e.importable &&
        !entryDeprecated(e),
    );
  // Stages the entry for review: the answer is the staged import, which the review page reads.
  const stage = useAppMutation({
    fn: (e: MarketplaceEntry) => importMarketplaceEntry(e, e.version),
    invalidates: () => [],
    onSuccess: (p) => qc.setQueryData(stagedImportQuery(p.stagingId).queryKey, p),
  });
  // A deployed service the super admin disabled: the extension page's enable, from its row
  const enable = useAppMutation({
    fn: (name: string) => enableExtension(name),
    invalidates: () => extensionChangeKeys(orgId),
  });
  async function enableService(name: string) {
    setBusy(name);
    setNotice(undefined);
    try {
      await enable.mutateAsync(name);
    } catch (err) {
      setNotice({ message: errorMessage(err), extra: issueLines(err) });
    } finally {
      setBusy(undefined);
    }
  }
  async function install(e: MarketplaceEntry) {
    setBusy(e.name);
    setNotice(undefined);
    try {
      const p = await stage.mutateAsync(e);
      router.push(importPageHref(p.stagingId));
    } catch (err) {
      setNotice({ message: errorMessage(err), extra: issueLines(err) });
    } finally {
      setBusy(undefined);
    }
  }

  const deployed: ItemListRow[] = services.map((p) => {
    const label = extensionLabel(p, lang);
    const attention = p.status !== "enabled" && p.status !== "disabled";
    // disabled on the deployment and not held off by another provider of a single-provider point
    const canEnable = p.desired?.state === "disabled" && p.enableBlocked === undefined;
    return {
      id: `ext:${p.name}`,
      mark: { text: label, image: p.icon ?? null },
      title: label,
      href: `/admin/extensions/${encodeURIComponent(p.name)}`,
      meta: [p.displayName ? p.name : null, versionLabel(p.version)]
        .filter((x): x is string => x !== null)
        .join(" · "),
      status: { label: ts(p.status), ...(attention ? { tone: "accent" as const } : {}) },
      ...(p.configurable || canEnable
        ? {
            actions: (
              <>
                {canEnable && (
                  <Button
                    density="dense"
                    variant="secondary"
                    loading={busy === p.name}
                    disabled={busy !== undefined}
                    aria-label={t("setup.enableLabel", { plugin: label })}
                    onClick={() => void enableService(p.name)}
                  >
                    {t("setup.enable")}
                  </Button>
                )}
                {p.configurable && (
                  <Button
                    density="dense"
                    aria-label={t("setup.configureLabel", { plugin: label })}
                    onClick={() => setOpen(p.name)}
                  >
                    {t("setup.configure")}
                  </Button>
                )}
              </>
            ),
          }
        : {}),
    };
  });
  const installable: ItemListRow[] = candidates.map((e) => {
    const label = displayNameOf(e, lang);
    return {
      id: `market:${e.sourceId}/${e.name}`,
      mark: { text: label, image: e.icon ?? null },
      title: label,
      meta: [
        e.displayName ? e.name : null,
        e.version !== null ? versionLabel(e.version) : null,
        e.sourceName,
      ]
        .filter((x): x is string => x !== null)
        .join(" · "),
      status: { label: t("setup.notInstalled") },
      actions: (
        <Button
          density="dense"
          variant="secondary"
          loading={busy === e.name}
          disabled={busy !== undefined}
          aria-label={t("setup.installLabel", { plugin: label })}
          onClick={() => void install(e)}
        >
          {t("setup.install")}
        </Button>
      ),
    };
  });
  const current = open === null ? undefined : services.find((p) => p.name === open);
  return (
    <Stack gap={16}>
      {notice !== undefined && <FormError message={notice.message} extra={notice.extra} />}
      <FormSection
        id="services"
        layout="stacked"
        title={t("setup.title")}
        description={t("setup.description")}
        flush
      >
        <ItemList
          label={t("setup.title")}
          inset="flush"
          rows={[...deployed, ...installable]}
          empty={{
            text: t("noProviders"),
            action: (
              <LinkButton href="/admin/plugins/market" variant="primary">
                {t("toMarket")}
              </LinkButton>
            ),
          }}
        />
      </FormSection>
      {deployed.length + installable.length > 0 && (
        <Stack direction="row" gap={12} align="center" wrap>
          <Text variant="prose" tone="muted">
            {t("setup.marketPointer")}
          </Text>
          <LinkButton href="/admin/plugins/market" density="dense">
            {t("toMarket")}
          </LinkButton>
        </Stack>
      )}
      {current !== undefined && (
        <ModelServiceSheet
          key={current.name}
          plugin={current}
          drainSeconds={drainSeconds}
          orgId={orgId}
          onClose={() => setOpen(null)}
        />
      )}
    </Stack>
  );
}

/**
 * One model service's deployment config in a Sheet: the status line, the config form (its save
 * in the footer) and the org copies; its extension page (lifecycle, replicas, permissions) opens
 * from the head.
 */
function ModelServiceSheet({
  plugin,
  drainSeconds,
  orgId,
  onClose,
}: {
  plugin: AdminExtension;
  drainSeconds: number;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("admin.extensions");
  const lang = labelLocale(useLocale());
  const qc = useQueryClient();
  // A save may change the extension's state, the platform's models and the org's readiness.
  const config = useDeploymentConfig({
    name: plugin.name,
    drainSeconds,
    pending: plugin.status === "pending_config",
    enabled: plugin.configurable,
    sheet: true,
    onChanged: () => {
      for (const queryKey of [
        adminExtensionsQuery().queryKey,
        keys.deployment().adminModels(),
        ...extensionChangeKeys(orgId),
      ])
        void qc.invalidateQueries({ queryKey });
    },
  });
  const label = extensionLabel(plugin, lang);
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={label}
      mark={{ text: label, image: plugin.icon ?? null }}
      meta={[plugin.displayName ? plugin.name : null, versionLabel(plugin.version)]
        .filter((x): x is string => x !== null)
        .join(" · ")}
      width={720}
      openHref={`/admin/extensions/${encodeURIComponent(plugin.name)}`}
      dirty={config.dirty}
      {...(config.save !== null ? { footer: config.save } : {})}
    >
      <Stack gap={16}>
        <ExtensionStatusMark status={plugin.status} orgsNeedingConfig={plugin.orgsNeedingConfig} />
        {config.notice}
        {config.form !== null && (
          <Subsection title={t("detail.sections.config")} variant="divided">
            {config.form}
          </Subsection>
        )}
        {config.copies}
      </Stack>
    </Sheet>
  );
}
