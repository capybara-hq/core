"use client";

import {
  Badge,
  type Column,
  DataTable,
  DateTime,
  type HeaderAction,
  KeyValue,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link } from "../i18n/navigation";
import {
  COMPONENT_ROUTES,
  type ComponentVersion,
  type PlatformComponent,
  type PlatformComponentKind,
  setComponentDisabled,
} from "../lib/components";
import { adminOrgsQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { componentChangeKeys } from "../lib/query/components";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import {
  ComponentDisableDialog,
  ComponentScopeDialog,
  ComponentUploadDialog,
} from "./ComponentScopeDialog";
import { useScopeLabel } from "./PluginsHead";

/** The deployment's orgs by id (a section: empty while it loads or failed). */
function useOrgNames(): (id: string) => string {
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
  return (id) => orgs.find((o) => o.id === id)?.name ?? id;
}

/**
 * A component's scope as text: the effective scope (指定组织 with the org names) and whether it
 * follows its plugin (跟随插件) or is its own (单独设置).
 */
export function useComponentScopeText(): (c: PlatformComponent) => string {
  const t = useTranslations("adminComponents");
  const scopeLabel = useScopeLabel();
  return (c) => {
    const scope = scopeLabel({ scope: c.scope, scopeOrgs: c.orgs });
    return c.scopeMode === "follow" && c.itemId !== null
      ? t("scopeFollow", { scope })
      : t("scopeOwn", { scope });
  };
}

/** The 来自 cell: the plugin, linking to its admin page, or 平台 for a component of none. */
export function ComponentFrom({ c }: { c: PlatformComponent }) {
  const t = useTranslations("adminComponents");
  if (c.plugin === null) return t("from.none");
  if (c.itemId === null) return c.plugin;
  return <Link href={`/admin/plugins/${encodeURIComponent(c.itemId)}`}>{c.plugin}</Link>;
}

/** Whether the platform owns it (an org's own item is read-only in the admin console). */
export const platformOwned = (c: PlatformComponent): boolean => c.owner.kind === "platform";

/** The 归属 text: 平台, or the owning org's name. */
export function useOwnerText(): (c: PlatformComponent) => string {
  const t = useTranslations("adminComponents");
  return (c) => (c.owner.kind === "platform" ? t("owner.platform") : c.owner.name);
}

/** The state chips of a component: 内置, 已停用, 插件已停用. */
export function StateBadges({ c }: { c: PlatformComponent }) {
  const t = useTranslations("adminComponents.state");
  return (
    <>
      {c.builtin && <Badge>{t("builtin")}</Badge>}
      {c.disabled && <Badge tone="warn">{t("disabled")}</Badge>}
      {c.pluginStopped && <Badge tone="warn">{t("pluginStopped")}</Badge>}
    </>
  );
}

/**
 * The admin list of one kind's platform components (spec §9): name (linking to its detail), 来自,
 * 归属, 范围, 版本 and how many orgs use it. `rows` null: loading.
 */
export function ComponentsTable({
  kind,
  rows,
}: {
  kind: PlatformComponentKind;
  rows: PlatformComponent[] | null;
}) {
  const t = useTranslations("adminComponents");
  const scopeText = useComponentScopeText();
  const ownerText = useOwnerText();
  const columns: Column<PlatformComponent>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (c) => (
        <Stack direction="row" gap={8} align="center">
          <Link href={`${COMPONENT_ROUTES[kind]}/${encodeURIComponent(c.id)}`}>{c.name}</Link>
          <StateBadges c={c} />
        </Stack>
      ),
    },
    { key: "from", header: t("columns.from"), tone: "muted", cell: (c) => <ComponentFrom c={c} /> },
    { key: "owner", header: t("columns.owner"), cell: (c) => ownerText(c) },
    { key: "scope", header: t("columns.scope"), cell: (c) => scopeText(c) },
    {
      key: "version",
      header: t("columns.version"),
      tone: "muted",
      cell: (c) => versionLabel(c.version),
    },
    {
      key: "orgs",
      header: t("columns.orgs"),
      tone: "muted",
      cell: (c) => t("orgsUsing", { n: c.onIn.length }),
    },
  ];
  return (
    <DataTable
      label={t(`titles.${kind}`)}
      columns={columns}
      rows={rows ?? []}
      rowKey={(c) => c.id}
      state={rows === null ? "loading" : "ready"}
      empty={{ title: t(`empty.${kind}`) }}
    />
  );
}

/** The detail's inspector: 来自, 归属, 范围, 在用组织, 版本, 状态. */
export function ComponentInspector({ c }: { c: PlatformComponent }) {
  const t = useTranslations("adminComponents");
  const scopeText = useComponentScopeText();
  const ownerText = useOwnerText();
  return (
    <KeyValue
      keyWidth="8ch"
      rows={[
        { k: t("detail.fields.from"), v: <ComponentFrom c={c} /> },
        { k: t("detail.fields.owner"), v: ownerText(c) },
        { k: t("detail.fields.scope"), v: scopeText(c) },
        { k: t("detail.fields.orgs"), v: String(c.onIn.length) },
        { k: t("detail.fields.version"), v: versionLabel(c.version) },
        {
          k: t("detail.fields.state"),
          v: c.disabled
            ? t("state.disabled")
            : c.pluginStopped
              ? t("state.pluginStopped")
              : t("detail.stateOn"),
        },
      ]}
    />
  );
}

/** 版本: each version, with where it came from (its plugin's version, or updated on its own). */
export function ComponentVersions({ versions }: { versions: ComponentVersion[] | null }) {
  const t = useTranslations("adminComponents.detail");
  const columns: Column<ComponentVersion>[] = [
    { key: "version", header: t("versionColumns.version"), cell: (v) => versionLabel(v.version) },
    {
      key: "origin",
      header: t("versionColumns.origin"),
      cell: (v) =>
        v.updatedOnOwn || v.catalogVersion === null ? (
          <Badge tone="warn">{t("origin.own")}</Badge>
        ) : (
          t("origin.plugin", { version: versionLabel(v.catalogVersion) })
        ),
    },
    {
      key: "created",
      header: t("versionColumns.created"),
      tone: "muted",
      cell: (v) => <DateTime value={v.createdAt} />,
    },
  ];
  return (
    <DataTable
      label={t("tabs.versions")}
      columns={columns}
      rows={versions ?? []}
      rowKey={(v) => v.version}
      state={versions === null ? "loading" : "ready"}
      empty={{ title: "—" }}
    />
  );
}

/** 组织: who the scope gives it to, and the orgs it is on in now. */
export function ComponentOrgs({ c }: { c: PlatformComponent }) {
  const t = useTranslations("adminComponents.detail");
  const locale = useLocale();
  const nameOf = useOrgNames();
  return (
    <Stack gap={8}>
      <Text variant="prose" tone="muted">
        {t(`orgsHint.${c.scope}`, { n: c.onIn.length })}
      </Text>
      <Text>
        {c.onIn.length === 0 ? t("noOrgs") : c.onIn.map(nameOf).join(locale === "zh" ? "、" : ", ")}
      </Text>
    </Stack>
  );
}

/**
 * The detail head's actions (设置范围, 停用 / 启用, 上传新版本 for a skill or agent template) and
 * the dialog they open.
 */
export function useComponentActions(
  c: PlatformComponent,
  orgId: string | null,
): { actions: HeaderAction[]; dialog: ReactNode } {
  const t = useTranslations("adminComponents.detail");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState<"scope" | "disable" | "upload" | null>(null);
  const enable = useAppMutation({
    fn: () => setComponentDisabled(c.kind, c.id, { disabled: false }),
    invalidates: () => componentChangeKeys(orgId),
  });
  const close = () => setOpen(null);
  const scopeAction: HeaderAction = {
    label: t("actions.scope"),
    variant: "default",
    onSelect: () => setOpen("scope"),
  };
  const disableAction: HeaderAction = c.disabled
    ? {
        label: t("actions.enable"),
        variant: "default",
        onSelect: () =>
          void enable.mutateAsync(undefined).then(
            () => toast.success(t("enabledToast", { name: c.name })),
            (e: unknown) => toast.error(errorMessage(e)),
          ),
      }
    : { label: t("actions.disable"), variant: "default", onSelect: () => setOpen("disable") };
  const uploadAction: HeaderAction = {
    label: t("actions.upload"),
    icon: "upload",
    variant: "primary",
    onSelect: () => setOpen("upload"),
  };
  // An org's own item is read-only here; a builtin plugin's component keeps its scope and stays
  // on (the kernel refuses both with 409 plugin.builtin), though it takes a new version
  const manage = platformOwned(c) && !c.builtin;
  const actions: HeaderAction[] = [
    ...(manage ? [scopeAction, disableAction] : []),
    ...(platformOwned(c) && c.kind !== "connector_template" ? [uploadAction] : []),
  ];
  const dialog =
    open === "scope" ? (
      <ComponentScopeDialog component={c} orgId={orgId} onClose={close} />
    ) : open === "disable" ? (
      <ComponentDisableDialog component={c} orgId={orgId} onClose={close} />
    ) : open === "upload" ? (
      <ComponentUploadDialog component={c} orgId={orgId} onClose={close} />
    ) : null;
  return { actions, dialog };
}

/** The 全部 / 平台 / 组织创建 tabs of a component list, with their counts and filtered rows. */
export function useOwnerTabs(rows: PlatformComponent[] | null): {
  items: { id: string; label: string; count?: number; onSelect(): void }[];
  active: string;
  rows: PlatformComponent[] | null;
} {
  const t = useTranslations("adminComponents.tabs");
  const [active, setActive] = useState<"all" | "platform" | "org">("all");
  const platform = rows?.filter(platformOwned) ?? null;
  const org = rows?.filter((c) => !platformOwned(c)) ?? null;
  const count = (r: PlatformComponent[] | null) => (r === null ? {} : { count: r.length });
  return {
    items: [
      { id: "all", label: t("all"), ...count(rows), onSelect: () => setActive("all") },
      {
        id: "platform",
        label: t("platform"),
        ...count(platform),
        onSelect: () => setActive("platform"),
      },
      { id: "org", label: t("org"), ...count(org), onSelect: () => setActive("org") },
    ],
    active,
    rows: active === "platform" ? platform : active === "org" ? org : rows,
  };
}

/** The detail's notes: disabled, plugin stopped, builtin, org-owned. */
export function ComponentNotes({ c }: { c: PlatformComponent }) {
  const t = useTranslations("adminComponents.detail");
  return (
    <>
      {!platformOwned(c) && (
        <Text variant="prose" tone="muted">
          {t("orgOwnedNote")}
        </Text>
      )}
      {c.builtin && (
        <Text variant="prose" tone="muted">
          {t("builtinNote")}
        </Text>
      )}
      {c.disabled && <Text tone="warn">{t("disabledNote")}</Text>}
      {c.pluginStopped && <Text tone="warn">{t("pluginStoppedNote")}</Text>}
    </>
  );
}
