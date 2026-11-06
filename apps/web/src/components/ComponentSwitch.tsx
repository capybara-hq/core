"use client";

import { Button, Dialog, LinkButton, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError, issueLines } from "../lib/api";
import {
  type ComponentSwitchPreview,
  type OrgComponent,
  setOrgComponentSwitch,
} from "../lib/components";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { FormError } from "./form-error";
import type { PluginAction, PluginStateLabel } from "./PluginSwitch";

/** One action on a component: 启用, 停用 (`danger`, a row's menu) or 查看插件 (a link). */
export interface ComponentAction extends Omit<PluginAction, "id"> {
  id: "enable" | "disable" | "plugin";
}

/**
 * A platform component's state in the org (spec §9, §13.5): 已启用 · 平台统一 for `all`, 已启用,
 * 插件未启用 for one whose plugin is off here (it comes on with the plugin), 未启用.
 */
export function useComponentState(): (c: OrgComponent) => PluginStateLabel {
  const t = useTranslations("orgComponents.state");
  return (c) =>
    c.on
      ? c.locked
        ? { label: t("platform"), tone: "ok" }
        : { label: t("on"), tone: "ok" }
      : c.pluginOn
        ? { label: t("off"), tone: "muted" }
        : { label: t("pluginOff"), tone: "muted" };
}

/**
 * What switching a component changes in the org: its lists, the usable sets, every skill detail
 * (the platform skill's and its linked copies', cached under their own ids), its plugin's view.
 */
export const componentSwitchKeys = (orgId: string) => {
  const k = keys.org(orgId);
  return [
    k.componentsAll(),
    k.skills(),
    k.skillAll(),
    k.agentTemplates(),
    k.connectors(),
    k.catalog(),
    k.catalogItemsAll(),
  ];
};

const keyOf = (c: OrgComponent) => `${c.kind}:${c.id}`;

/**
 * The org admin's switch of one platform component (spec §5 rule 5, §13.5): 启用 on one that is
 * off (a skill whose name the org already uses is refused, rule 10), 停用 on one that is on unless
 * it is `all` (previewed with the agents that use it, confirmed with the preview's hash), 查看插件
 * on one whose plugin is off here. Members get no action (the pages are read-only for them).
 */
export function useComponentSwitch({ orgId, admin }: { orgId: string; admin: boolean }): {
  actionsOf(c: OrgComponent): ComponentAction[];
  dialog: ReactNode;
  error: { message: string; extra: string[] } | undefined;
  busy: boolean;
} {
  const t = useTranslations("orgComponents");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [busy, setBusy] = useState(false);
  /** The component whose switch call is running (its action is drawn pending). */
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [off, setOff] = useState<{ c: OrgComponent; preview: ComponentSwitchPreview } | null>(null);
  const [notice, setNotice] = useState<string>();
  const sw = useAppMutation({
    fn: (v: { c: OrgComponent; enabled: boolean; confirm?: string }) =>
      setOrgComponentSwitch(orgId, v.c.kind, v.c.id, {
        enabled: v.enabled,
        ...(v.confirm !== undefined && { confirm: v.confirm }),
      }),
    invalidates: () => componentSwitchKeys(orgId),
  });

  /** A refusal in the component's words (a name taken, `all`), else the code's own copy. */
  const messageOf = (c: OrgComponent, e: unknown): string => {
    if (e instanceof ApiClientError && e.code === "plugin.skill_conflict") {
      return t(`error.conflict.${c.kind}`, { name: c.name });
    }
    if (e instanceof ApiClientError && e.code === "plugin.scope_locked") {
      return t("error.locked", { name: c.name });
    }
    return errorMessage(e);
  };

  const enable = async (c: OrgComponent) => {
    if (busy) return;
    setBusy(true);
    setRunning(keyOf(c));
    setError(undefined);
    try {
      await sw.mutateAsync({ c, enabled: true });
      toast.success(t("toast.enabled", { name: c.name }));
    } catch (e) {
      setError({ message: messageOf(c, e), extra: [...issueLines(e), ...catalogLines(e)] });
    } finally {
      setBusy(false);
      setRunning(undefined);
    }
  };
  // The first off call answers the preview (or switches off at once when it was off already)
  const disable = async (c: OrgComponent) => {
    if (busy) return;
    setBusy(true);
    setRunning(keyOf(c));
    setError(undefined);
    try {
      const r = await sw.mutateAsync({ c, enabled: false });
      if ("preview" in r) {
        setNotice(undefined);
        setOff({ c, preview: r });
        return;
      }
      toast.success(t("toast.disabled", { name: c.name }));
    } catch (e) {
      setError({ message: messageOf(c, e), extra: [...issueLines(e), ...catalogLines(e)] });
    } finally {
      setBusy(false);
      setRunning(undefined);
    }
  };
  const confirmOff = async () => {
    if (off === null) return;
    const { c, preview } = off;
    setBusy(true);
    try {
      const r = await sw.mutateAsync({ c, enabled: false, confirm: preview.confirm });
      if ("preview" in r) {
        setOff({ c, preview: r });
        return;
      }
      setOff(null);
      toast.success(t("toast.disabled", { name: c.name }));
    } catch (e) {
      // What it takes away changed since the preview: show the new one before confirming again
      if (e instanceof ApiClientError && e.code === "plugin.switch_stale") {
        try {
          const again = await sw.mutateAsync({ c, enabled: false });
          if ("preview" in again) {
            setOff({ c, preview: again });
            setNotice(t("switchOff.stale"));
          } else setOff(null);
        } catch (e2) {
          setNotice(messageOf(c, e2));
        }
        return;
      }
      setNotice(messageOf(c, e));
    } finally {
      setBusy(false);
    }
  };

  const actionsOf = (c: OrgComponent): ComponentAction[] =>
    baseActions(c).map((a) =>
      running === keyOf(c) && a.onSelect !== undefined ? { ...a, loading: true } : a,
    );
  const baseActions = (c: OrgComponent): ComponentAction[] => {
    if (!admin || c.locked) return [];
    if (!c.pluginOn) {
      return c.itemId === null
        ? []
        : [
            {
              id: "plugin",
              label: t("action.plugin"),
              href: `/plugins/${encodeURIComponent(c.itemId)}`,
            },
          ];
    }
    if (!c.switchable) return [];
    return c.on
      ? [
          {
            id: "disable",
            label: t("action.disable"),
            danger: true,
            onSelect: () => void disable(c),
          },
        ]
      : [{ id: "enable", label: t("action.enable"), onSelect: () => void enable(c) }];
  };

  const dialog =
    off === null ? null : (
      <ComponentSwitchOffDialog
        name={off.c.name}
        kind={off.c.kind}
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
 * The switch-off confirmation of one component (spec §5 rule 8 for one org): the org's agents that
 * use it lose it; a connector template's connectors stay as the org's own.
 */
function ComponentSwitchOffDialog({
  name,
  kind,
  preview,
  busy,
  notice,
  onConfirm,
  onCancel,
}: {
  name: string;
  kind: OrgComponent["kind"];
  preview: ComponentSwitchPreview["preview"];
  busy: boolean;
  notice: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useTranslations("orgComponents.switchOff");
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
        <Text variant="prose">{t(`hint.${kind}`)}</Text>
        {preview.agents.length > 0 ? (
          <Stack gap={4}>
            <Text variant="small" tone="warn">
              {t("agents")}
            </Text>
            {preview.agents.map((a) => (
              <Text key={a.id} variant="small">{`· ${a.name}`}</Text>
            ))}
          </Stack>
        ) : (
          <Text variant="small" tone="muted">
            {t("noAgents")}
          </Text>
        )}
        {preview.connectorsKept > 0 && (
          <Text variant="small" tone="muted">
            {t("connectorsKept", { n: preview.connectorsKept })}
          </Text>
        )}
      </Stack>
    </Dialog>
  );
}

/**
 * A plugin's components in the org (its detail, spec §9): kind, name, state and the org admin's
 * per-component switch (spec §5 rule 5: only that component). Members see the states only.
 */
export function ComponentSwitchList({
  orgId,
  admin,
  components,
}: {
  orgId: string;
  admin: boolean;
  components: readonly OrgComponent[];
}) {
  const t = useTranslations("orgComponents");
  const stateOf = useComponentState();
  const { actionsOf, dialog, error, busy } = useComponentSwitch({ orgId, admin });
  return (
    <Stack gap={8}>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      {components.map((c) => {
        const state = stateOf(c);
        return (
          <Stack key={`${c.kind}:${c.id}`} direction="row" gap={12} align="center" wrap>
            <Text variant="small" tone="muted">
              {t(`kind.${c.kind}`)}
            </Text>
            <Text>{c.name}</Text>
            <Text variant="small" tone={state.tone}>
              {state.label}
            </Text>
            {actionsOf(c).map((a) =>
              a.href !== undefined ? (
                <LinkButton key={a.id} href={a.href}>
                  {a.label}
                </LinkButton>
              ) : (
                <Button
                  key={a.id}
                  density="dense"
                  {...(a.danger === true ? { variant: "danger" as const } : {})}
                  aria-label={`${a.label} ${c.name}`}
                  loading={a.loading === true}
                  disabled={busy}
                  onClick={a.onSelect}
                >
                  {a.label}
                </Button>
              ),
            )}
          </Stack>
        );
      })}
      {dialog}
    </Stack>
  );
}
