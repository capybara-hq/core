"use client";

import { Button, Dialog, type MenuItem, Stack, Text, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError, issueLines } from "../lib/api";
import {
  displayNameOf,
  type OrgCatalogItem,
  ownedBy,
  requestCatalogItem,
  type SwitchPreview,
  setOrgPluginSwitch,
  type UninstallPreview,
  withdrawPending,
} from "../lib/catalog";
import type { OrgExtension } from "../lib/extensions";
import { pluginChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { pluginInstallsQuery } from "../lib/query/settings";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { hasConfigFields } from "./config-form/model";
import { FormError } from "./form-error";

/** A plugin's state in the org as a label and its tone (spec §9, the workspace 插件 page). */
export type PluginStateLabel = { label: string; tone: "ok" | "warn" | "muted" };

/**
 * The state copy of a plugin from the org's view: a pending request first (已申请，等待处理),
 * then the state; `on` for an `all` or builtin plugin reads 已启用 · 平台统一. An extension the
 * deployment lacks is said instead of 未启用 / 需要配置 (it cannot be switched on).
 */
export function usePluginState(): (item: OrgCatalogItem) => PluginStateLabel {
  const t = useTranslations("plugins.state");
  return (i) => {
    // The org's own upload waiting for the super admin (P3-9): nothing of it is usable yet
    if (i.awaitingConfirmation === true) return { label: t("awaiting"), tone: "warn" };
    if (i.request !== null) return { label: t("requested"), tone: "muted" };
    switch (i.state) {
      case "unavailable":
        return { label: t("unavailable"), tone: "muted" };
      case "not_offered":
        return { label: t("not_offered"), tone: "muted" };
      case "on":
        return i.builtin || i.scope === "all"
          ? { label: t("platform"), tone: "ok" }
          : { label: t("on"), tone: "ok" };
      default:
        if (i.notDeployed) return { label: t("notDeployed"), tone: "warn" };
        return i.state === "needs_config"
          ? { label: t("needs_config"), tone: "warn" }
          : { label: t("off"), tone: "muted" };
    }
  };
}

/** The org's extension a plugin brings (matched by its catalog item), when the list has it. */
export const ownExtension = (
  item: Pick<OrgCatalogItem, "id">,
  extensions: OrgExtension[] | undefined,
): OrgExtension | undefined => extensions?.find((e) => e.catalogItem?.itemId === item.id);

/**
 * Whether switching a plugin on asks for input first (the wizard at `/plugins/<id>/enable`): its
 * connector templates, an org config the kernel still misses (`needs_config`), or its extension's
 * org config form when the extension is off (unknown extensions: ask, the wizard says when there
 * is nothing to fill in).
 */
export function needsInput(item: OrgCatalogItem, extensions: OrgExtension[] | undefined): boolean {
  if (item.state === "needs_config") return true;
  if (item.componentCounts.connectorTemplates > 0) return true;
  if (item.componentCounts.extension === 0) return false;
  if (extensions === undefined) return true;
  const own = ownExtension(item, extensions);
  return own !== undefined && !own.enabled && hasConfigFields(own.orgConfigSchema);
}

/** One action on a plugin: a link, or a call. `danger` (停用) belongs in a row's menu. */
export interface PluginAction {
  id: "enable" | "configure" | "connectors" | "disable" | "request" | "requestEnable" | "withdraw";
  label: string;
  href?: string;
  onSelect?(): void;
  danger?: boolean;
}

/**
 * A row's actions as ObjectRow wants them: the first safe one as its action, the others (停用
 * last) in its menu.
 */
export function rowActions(actions: readonly Omit<PluginAction, "id">[]): {
  action?: { label: string; href?: string; onSelect?(): void };
  menu?: MenuItem[];
} {
  const safe = actions.find((a) => a.danger !== true);
  // The other actions sit in the menu: more safe ones (撤回 of a pending version), then 停用
  const danger = [
    ...actions.filter((a) => a.danger !== true && a !== safe),
    ...actions.filter((a) => a.danger === true),
  ];
  return {
    ...(safe !== undefined && {
      action: {
        label: safe.label,
        ...(safe.href !== undefined ? { href: safe.href } : {}),
        ...(safe.onSelect !== undefined ? { onSelect: safe.onSelect } : {}),
      },
    }),
    ...(danger.length > 0 && {
      menu: danger.map((a) => ({
        label: a.label,
        ...(a.danger === true && { danger: true }),
        onSelect: a.onSelect ?? (() => {}),
      })),
    }),
  };
}

/**
 * The actions on the org's plugins (spec §5.1, §9) and the switch-off dialog they open. Org admins:
 * 启用 (straight to the switch, or to the input wizard when it asks for input), 组织配置 (the
 * extension's org config on 扩展), 停用 (previewed: what it takes away and the agents that use it;
 * confirmed with the preview's hash; never on `all` / builtin plugins), 申请 (`access`, a plugin
 * not offered to the org). Members: 申请启用 (`enable`) on an `optional` plugin that is off.
 * Nothing while a request is pending, or on a plugin the platform stopped. Each call invalidates
 * what a plugin change touches; failures land in `error`.
 */
export function usePluginActions({
  orgId,
  admin,
  extensions,
}: {
  orgId: string;
  admin: boolean;
  /** The org's extensions (org admins), undefined while they load or for members. */
  extensions: OrgExtension[] | undefined;
}): {
  actionsOf(item: OrgCatalogItem): PluginAction[];
  /** The switch-off dialog, to render once on the page. */
  dialog: ReactNode;
  error: { message: string; extra: string[] } | undefined;
  busy: boolean;
} {
  const t = useTranslations("plugins");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [off, setOff] = useState<{ item: OrgCatalogItem; preview: SwitchPreview } | null>(null);
  const [notice, setNotice] = useState<string>();
  const sw = useAppMutation({
    fn: (v: { itemId: string; enabled: boolean; confirm?: string }) =>
      setOrgPluginSwitch(
        orgId,
        v.itemId,
        v.enabled
          ? { enabled: true }
          : { enabled: false, ...(v.confirm !== undefined && { confirm: v.confirm }) },
      ),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const pull = useAppMutation({
    fn: (itemId: string) => withdrawPending(orgId, itemId),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const ask = useAppMutation({
    fn: (v: { itemId: string; kind: "access" | "enable" }) =>
      requestCatalogItem(orgId, v.itemId, v.kind, ""),
    invalidates: () => [keys.org(orgId).catalog(), keys.org(orgId).catalogItemsAll()],
  });

  const run = async (op: () => Promise<string | undefined>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const done = await op();
      if (done !== undefined) toast.success(done);
    } catch (e) {
      setError({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (i: OrgCatalogItem) => displayNameOf(i, locale);

  const enable = (i: OrgCatalogItem) =>
    run(async () => {
      await sw.mutateAsync({ itemId: i.id, enabled: true });
      return t("toast.enabled", { name: nameOf(i) });
    });
  // The first off call answers the preview (or switches off at once when nothing is installed)
  const disable = (i: OrgCatalogItem) =>
    run(async () => {
      const r = await sw.mutateAsync({ itemId: i.id, enabled: false });
      if ("preview" in r) {
        setNotice(undefined);
        setOff({ item: i, preview: r });
        return undefined;
      }
      return t("toast.disabled", { name: nameOf(i) });
    });
  const confirmOff = async () => {
    if (off === null) return;
    const { item, preview } = off;
    setBusy(true);
    try {
      const r = await sw.mutateAsync({ itemId: item.id, enabled: false, confirm: preview.confirm });
      if ("preview" in r) {
        setOff({ item, preview: r });
        return;
      }
      setOff(null);
      toast.success(t("toast.disabled", { name: nameOf(item) }));
    } catch (e) {
      // What it takes away changed since the preview: show the new one before confirming again
      if (e instanceof ApiClientError && e.code === "plugin.switch_stale") {
        try {
          const again = await sw.mutateAsync({ itemId: item.id, enabled: false });
          if ("preview" in again) {
            setOff({ item, preview: again });
            setNotice(t("switchOff.stale"));
            return;
          }
          setOff(null);
          return;
        } catch (e2) {
          setNotice(errorMessage(e2));
          return;
        }
      }
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const request = (i: OrgCatalogItem, kind: "access" | "enable") =>
    run(async () => {
      await ask.mutateAsync({ itemId: i.id, kind });
      return t("toast.requested");
    });

  const withdraw = (i: OrgCatalogItem) =>
    run(async () => {
      await pull.mutateAsync(i.id);
      return t("toast.withdrawn", { name: nameOf(i) });
    });

  const actionsOf = (i: OrgCatalogItem): PluginAction[] => {
    // The org's own upload waiting for the super admin: 撤回 (org admins), nothing else while
    // its first version waits (P3-10)
    const pending =
      admin && ownedBy(i, orgId) && (i.awaitingConfirmation === true || i.pendingVersion != null);
    const withdrawAction: PluginAction[] = pending
      ? [{ id: "withdraw", label: t("action.withdraw"), onSelect: () => void withdraw(i) }]
      : [];
    if (i.awaitingConfirmation === true) return withdrawAction;
    return [...stateActions(i), ...withdrawAction];
  };
  const stateActions = (i: OrgCatalogItem): PluginAction[] => {
    if (i.request !== null || i.state === "unavailable") return [];
    if (!admin) {
      return i.state === "off" && i.scope === "optional" && !i.builtin
        ? [
            {
              id: "requestEnable",
              label: t("action.requestEnable"),
              onSelect: () => void request(i, "enable"),
            },
          ]
        : [];
    }
    if (i.state === "not_offered") {
      return [
        { id: "request", label: t("action.request"), onSelect: () => void request(i, "access") },
      ];
    }
    // Installed but a connector template on here misses its connector (P2-10): 补充配置
    if (i.state === "needs_config" && i.installed !== null) {
      return [
        {
          id: "connectors",
          label: t("action.connectors"),
          href: `/plugins/${encodeURIComponent(i.id)}/connectors`,
        },
        ...(i.switchable
          ? [
              {
                id: "disable" as const,
                label: t("action.disable"),
                danger: true,
                onSelect: () => void disable(i),
              },
            ]
          : []),
      ];
    }
    if (i.state === "off" || i.state === "needs_config") {
      if (i.notDeployed) return [];
      return [
        needsInput(i, extensions)
          ? {
              id: "enable",
              label: t("action.enable"),
              href: `/plugins/${encodeURIComponent(i.id)}/enable`,
            }
          : { id: "enable", label: t("action.enable"), onSelect: () => void enable(i) },
      ];
    }
    // On: the extension's org config when it has a form; 停用 unless the platform turned it on
    const own = ownExtension(i, extensions);
    return [
      ...(own?.configurable === true && hasConfigFields(own.orgConfigSchema)
        ? [
            {
              id: "configure" as const,
              label: t("action.configure"),
              href: `/extensions#plugin-${encodeURIComponent(own.plugin)}`,
            },
          ]
        : []),
      ...(i.switchable
        ? [
            {
              id: "disable" as const,
              label: t("action.disable"),
              danger: true,
              onSelect: () => void disable(i),
            },
          ]
        : []),
    ];
  };

  const dialog =
    off === null ? null : (
      <SwitchOffDialog
        orgId={orgId}
        name={nameOf(off.item)}
        preview={off.preview.preview}
        busy={busy}
        notice={notice}
        onConfirm={() => void confirmOff()}
        onCancel={() => setOff(null)}
      />
    );
  return { actionsOf, dialog, error, busy };
}

/**
 * The switch-off confirmation (spec §5 rule 8): what switching the plugin off removes (the
 * components it created and nothing else uses), what it keeps and why, and the agents that use
 * its components (they lose them). A dependency install (`plugin`) is named by its plugin, from the
 * org's installs (its id until they are read). Shared by the 插件 page and the 扩展 page (an
 * extension's switch is its plugin's).
 */
export function SwitchOffDialog({
  orgId,
  name,
  preview,
  busy,
  notice,
  onConfirm,
  onCancel,
}: {
  orgId: string;
  name: string;
  preview: UninstallPreview;
  busy: boolean;
  /** A line above the lists (the preview changed; a failure). */
  notice?: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useTranslations("plugins.switchOff");
  const tk = useTranslations("catalog.plugins");
  const locale = useLocale();
  const sep = locale === "zh" ? "、" : ", ";
  const kind = (k: string) => (tk.has(`componentKind.${k}`) ? tk(`componentKind.${k}`) : k);
  const iq = pluginInstallsQuery(orgId);
  const installs = useQuery({ ...iq, retryOnMount: retryOnMountOf(iq.queryKey) }).data?.installs;
  const refOf = (c: { kind: string; ref: string }) =>
    c.kind === "plugin" ? (installs?.find((i) => i.id === c.ref)?.name ?? c.ref) : c.ref;
  const removed = preview.components.filter((c) => c.created);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title={t("title", { name })}
      danger
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant="danger-solid" loading={busy} disabled={busy} onClick={onConfirm}>
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        {notice !== undefined && <FormError message={notice} />}
        <Text variant="prose">{t("hint")}</Text>
        {preview.agents.length > 0 && (
          <Stack gap={4}>
            <Text variant="small" tone="warn">
              {t("agents")}
            </Text>
            {preview.agents.map((a) => (
              <Text key={a.id} variant="small">
                {`· ${a.name}: ${a.uses.map((u) => `${kind(u.kind)} ${refOf(u)}`).join(sep)}`}
              </Text>
            ))}
          </Stack>
        )}
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("removed")}
          </Text>
          {removed.length === 0 && <Text variant="small">{t("none")}</Text>}
          {removed.map((c) => (
            <Text key={`${c.kind}:${c.ref}`} variant="small">
              {`− ${kind(c.kind)} ${refOf(c)}`}
            </Text>
          ))}
        </Stack>
        {preview.kept.length > 0 && (
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("kept")}
            </Text>
            {preview.kept.map((c) => (
              <Text key={`${c.kind}:${c.ref}`} variant="small">
                {`· ${kind(c.kind)} ${refOf(c)} — ${
                  tk.has(`report.reason.${c.reason}`) ? tk(`report.reason.${c.reason}`) : c.reason
                }`}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </Dialog>
  );
}
