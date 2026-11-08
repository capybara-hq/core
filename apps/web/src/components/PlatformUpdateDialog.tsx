"use client";

import {
  Badge,
  Button,
  Callout,
  type Column,
  DataTable,
  Dialog,
  ImpactPreview,
  type ImpactPreviewGroup,
  type ImpactPreviewNote,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  type CatalogItem,
  displayNameOf,
  type PlatformUpdateComponent,
  type PlatformUpdatePreview,
  previewPlatformUpdate,
  updatePlatformPlugin,
} from "../lib/catalog";
import { adminOrgsQuery } from "../lib/query/admin";
import { pluginScopeChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { FormError } from "./form-error";
import { useAdminThemeName, useThemeImpactGroup } from "./ThemeImpact";

const optVersion = (v: string | null) => (v === null ? "—" : versionLabel(v));

/**
 * 更新到 x of a platform plugin (spec §7.1, ruling F2: one version per deployment): the preview
 * lists every component with its change (新增 / 移除 / 升级 / 降级 / 不变) and marks those updated
 * on their own, those with their own scope and removed ones kept because agents use them; the
 * orgs whose copies are pinned, the extension's move with the orgs using it (and whether the new
 * version waits for a permission confirmation), and per org the connectors updated, those whose
 * credentials are cleared and the added templates needing input. Confirmed with `diffHash`; 409
 * `plugin.upgrade_stale` previews again.
 */
export function PlatformUpdateDialog({
  item,
  version,
  orgId,
  onClose,
}: {
  item: CatalogItem;
  version: string;
  orgId: string | null;
  onClose(): void;
}) {
  const adminThemeName = useAdminThemeName();
  const t = useTranslations("catalog.update");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name;
  const name = displayNameOf(item, locale);
  const [preview, setPreview] = useState<PlatformUpdatePreview | null>(null);
  const catalogLines = useCatalogErrorLines();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const problem = useCallback(
    (e: unknown) => ({ message: errorMessage(e), extra: catalogLines(e) }),
    [errorMessage, catalogLines],
  );
  const [notice, setNotice] = useState<string>();
  const asked = useRef(false);
  const previewIt = useAppMutation({
    fn: () => previewPlatformUpdate(item.id, version),
    invalidates: () => [],
  });
  const update = useAppMutation({
    fn: (diffHash: string) => updatePlatformPlugin(item.id, { version, diffHash }),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  const { mutateAsync: ask } = previewIt;
  const load = useCallback(
    () =>
      ask(undefined).then(
        (p) => setPreview(p),
        (e: unknown) => setError(problem(e)),
      ),
    [ask, problem],
  );
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void load();
  }, [load]);
  const confirm = async () => {
    if (preview === null) return;
    setError(undefined);
    setNotice(undefined);
    try {
      await update.mutateAsync(preview.diffHash);
      toast.success(t("done", { name, version: versionLabel(version) }));
      onClose();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "plugin.upgrade_stale") {
        setPreview(null);
        await load();
        setNotice(t("stale"));
      } else setError(problem(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name })}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={preview === null || update.isPending}
            onClick={() => void confirm()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        {notice !== undefined && <Callout tone="warn">{notice}</Callout>}
        {preview === null ? (
          error === undefined && (
            <Text variant="prose" tone="muted">
              {t("loading")}
            </Text>
          )
        ) : (
          <PlatformUpdatePreviewBody
            preview={preview}
            orgName={orgName}
            themeName={adminThemeName}
          />
        )}
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    </Dialog>
  );
}

/**
 * The body of an update preview (shared by {@link PlatformUpdateDialog} and an org's upload of a
 * new version of its own plugin, ruling P3-12): the versions, every component with its change and
 * marks, the pinned copies, the components kept for agents, the extension's move and, per org,
 * the connectors updated, those whose credentials are cleared and the templates needing input.
 * `orgName` names an org id (its id when unknown). An org's own upload (`hideUnknown`, ruling
 * P3-19: an org admin cannot read other orgs) names the orgs the kernel named in `orgNames` or the
 * viewer belongs to, and counts the others ("N 个组织"), never showing an id.
 */
export function PlatformUpdatePreviewBody({
  preview,
  orgName,
  themeName = (id) => id,
  hideUnknown = false,
}: {
  preview: PlatformUpdatePreview;
  /** The org's name, or undefined when unknown (then its id, or a count with `hideUnknown`). */
  orgName(id: string): string | undefined;
  /** A theme's name by its `platform_themes` id (the 主题 group). */
  themeName?: (id: string) => string;
  hideUnknown?: boolean;
}) {
  const t = useTranslations("catalog.update");
  const locale = useLocale();
  const sep = locale === "zh" ? "、" : ", ";
  const nameOf = (id: string) => preview.orgNames?.[id] ?? orgName(id);
  const themeGroup = useThemeImpactGroup(preview.themes, themeName);
  const one = (id: string) => nameOf(id) ?? (hideUnknown ? t("otherOrg") : id);
  const names = (ids: string[]) => {
    if (!hideUnknown) return ids.map(one).join(sep);
    const known = ids.flatMap((id) => {
      const n = nameOf(id);
      return n === undefined ? [] : [n];
    });
    const unknown = ids.length - known.length;
    if (unknown === 0) return known.join(sep);
    if (known.length === 0) return t("orgCount", { count: unknown });
    return [...known, t("otherOrgs", { count: unknown })].join(sep);
  };
  const columns: Column<PlatformUpdateComponent>[] = [
    { key: "name", header: t("columns.name"), cell: (c) => c.name },
    { key: "kind", header: t("columns.kind"), tone: "muted", cell: (c) => t(`kind.${c.kind}`) },
    { key: "change", header: t("columns.change"), cell: (c) => t(`change.${c.change}`) },
    {
      key: "version",
      header: t("columns.version"),
      tone: "muted",
      cell: (c) => `${optVersion(c.from)} → ${optVersion(c.to)}`,
    },
    {
      key: "marks",
      header: t("columns.marks"),
      cell: (c) => (
        <Stack direction="row" gap={4} align="center">
          {c.updatedOnOwn && <Badge tone="warn">{t("marks.updatedOnOwn")}</Badge>}
          {c.ownScope && <Badge>{t("marks.ownScope")}</Badge>}
          {c.kept !== undefined && c.kept.length > 0 && <Badge>{t("marks.kept")}</Badge>}
        </Stack>
      ),
    },
  ];

  const changed = preview.components.filter((c) => c.change !== "same");
  const marked = preview.components.some((c) => c.updatedOnOwn || c.ownScope);
  const pinned = preview.components.filter(
    (c) => c.pinnedOrgs.length > 0 && c.change !== "removed",
  );
  const kept = preview.components.filter((c) => c.kept !== undefined && c.kept.length > 0);
  const ext = preview.extension;
  const extOrgs =
    ext === null ? "" : ext.orgs.length === 0 ? t("extensionNoOrgs") : names(ext.orgs);
  const componentHint = changed.length === 0 ? t("none") : marked ? t("marksHint") : undefined;
  const groups: ImpactPreviewGroup[] = [
    {
      id: "components",
      title: t("components"),
      ...(componentHint !== undefined ? { description: componentHint } : {}),
      ...(preview.components.length > 0
        ? {
            content: (
              <DataTable
                label={t("components")}
                columns={columns}
                rows={preview.components}
                rowKey={(c) => `${c.kind}:${c.id ?? c.name}`}
                state="ready"
                framed={false}
              />
            ),
          }
        : {}),
    },
    {
      id: "pinned",
      title: t("groups.pinned"),
      items: pinned.map((c) => ({
        id: `${c.kind}:${c.name}`,
        title: c.name,
        code: t(`kind.${c.kind}`),
        notes: [{ text: t("pinnedNote", { orgs: names(c.pinnedOrgs) }) }],
      })),
    },
    {
      id: "kept",
      title: t("groups.kept"),
      items: kept.map((c) => ({
        id: `${c.kind}:${c.name}`,
        title: c.name,
        code: t(`kind.${c.kind}`),
        notes: [
          {
            text: t("keptNote", {
              agents: (c.kept ?? []).flatMap((k) => k.agents.map((a) => a.name)).join(sep),
            }),
          },
        ],
      })),
    },
    {
      id: "extension",
      title: t("groups.extension"),
      items:
        ext === null
          ? []
          : [
              {
                id: "extension",
                title:
                  ext.from === null
                    ? t("extensionInstall", { to: optVersion(ext.to) })
                    : t("versions", { from: versionLabel(ext.from), to: optVersion(ext.to) }),
                notes: [{ text: t("extensionOrgs", { orgs: extOrgs }) }],
              },
            ],
    },
    {
      id: "orgs",
      title: t("groups.orgs"),
      items: preview.connectorOrgs.map((o) => {
        const reset = o.connectors.filter((c) => c.credentialsReset);
        const updated = o.connectors.filter((c) => !c.credentialsReset);
        const notes: ImpactPreviewNote[] = [];
        if (updated.length > 0)
          notes.push({
            text: t("connectorsNote", { names: updated.map((c) => c.name).join(sep) }),
          });
        if (reset.length > 0)
          notes.push({
            text: t("credentialsResetNote", { names: reset.map((c) => c.name).join(sep) }),
            tone: "warn",
          });
        if (o.needsConfig.length > 0)
          notes.push({
            text: t("needsConfigNote", { ids: o.needsConfig.join(sep) }),
            tone: "warn",
          });
        return { id: o.orgId, title: one(o.orgId), notes };
      }),
    },
    ...(themeGroup === null ? [] : [themeGroup]),
  ];
  return (
    <>
      {ext?.needsApproval === true && <Callout tone="warn">{t("needsApproval")}</Callout>}
      <Text>
        {t("versions", {
          from: optVersion(preview.from),
          to: versionLabel(preview.to),
        })}
      </Text>
      <ImpactPreview groups={groups} empty={t("none")} />
    </>
  );
}
