"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
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
        {notice !== undefined && (
          <Text variant="prose" tone="warn">
            {notice}
          </Text>
        )}
        {preview === null ? (
          error === undefined && (
            <Text variant="prose" tone="muted">
              {t("loading")}
            </Text>
          )
        ) : (
          <PlatformUpdatePreviewBody preview={preview} orgName={orgName} />
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
  hideUnknown = false,
}: {
  preview: PlatformUpdatePreview;
  /** The org's name, or undefined when unknown (then its id, or a count with `hideUnknown`). */
  orgName(id: string): string | undefined;
  hideUnknown?: boolean;
}) {
  const t = useTranslations("catalog.update");
  const locale = useLocale();
  const sep = locale === "zh" ? "、" : ", ";
  const nameOf = (id: string) => preview.orgNames?.[id] ?? orgName(id);
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
  return (
    <>
      <Text>
        {t("versions", {
          from: optVersion(preview.from),
          to: versionLabel(preview.to),
        })}
      </Text>
      {preview.components.length === 0 ? (
        <Text variant="prose">{t("none")}</Text>
      ) : (
        <DataTable
          label={t("components")}
          columns={columns}
          rows={preview.components}
          rowKey={(c) => `${c.kind}:${c.id ?? c.name}`}
          state="ready"
          framed={false}
        />
      )}
      {changed.length === 0 && preview.components.length > 0 && (
        <Text variant="prose" tone="muted">
          {t("none")}
        </Text>
      )}
      {marked && (
        <Text variant="small" tone="muted">
          {t("marksHint")}
        </Text>
      )}
      {preview.components
        .filter((c) => c.pinnedOrgs.length > 0 && c.change !== "removed")
        .map((c) => (
          <Text key={`pin:${c.kind}:${c.name}`} variant="small">
            {t("pinned", { name: c.name, orgs: names(c.pinnedOrgs) })}
          </Text>
        ))}
      {preview.components
        .filter((c) => c.kept !== undefined && c.kept.length > 0)
        .map((c) => (
          <Text key={`kept:${c.kind}:${c.name}`} variant="small">
            {t("keptLine", {
              name: c.name,
              agents: (c.kept ?? []).flatMap((k) => k.agents.map((a) => a.name)).join(sep),
            })}
          </Text>
        ))}
      {preview.extension !== null && (
        <Stack gap={4}>
          <Text variant="prose">
            {preview.extension.from === null
              ? t("extensionNew", {
                  to: optVersion(preview.extension.to),
                  orgs:
                    preview.extension.orgs.length === 0
                      ? t("extensionNoOrgs")
                      : names(preview.extension.orgs),
                })
              : t("extension", {
                  from: versionLabel(preview.extension.from),
                  to: optVersion(preview.extension.to),
                  orgs:
                    preview.extension.orgs.length === 0
                      ? t("extensionNoOrgs")
                      : names(preview.extension.orgs),
                })}
          </Text>
          {preview.extension.needsApproval && (
            <Text variant="prose" tone="warn">
              {t("needsApproval")}
            </Text>
          )}
        </Stack>
      )}
      {preview.connectorOrgs.map((o) => {
        const reset = o.connectors.filter((c) => c.credentialsReset);
        const kept = o.connectors.filter((c) => !c.credentialsReset);
        return (
          <Stack key={o.orgId} gap={4}>
            {kept.length > 0 && (
              <Text variant="small">
                {t("connectors", {
                  org: one(o.orgId),
                  names: kept.map((c) => c.name).join(sep),
                })}
              </Text>
            )}
            {reset.length > 0 && (
              <Text variant="small" tone="warn">
                {t("credentialsReset", {
                  org: one(o.orgId),
                  names: reset.map((c) => c.name).join(sep),
                })}
              </Text>
            )}
            {o.needsConfig.length > 0 && (
              <Text variant="small" tone="warn">
                {t("needsConfig", { org: one(o.orgId), ids: o.needsConfig.join(sep) })}
              </Text>
            )}
          </Stack>
        );
      })}
    </>
  );
}
