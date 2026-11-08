"use client";

import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  Field,
  ImpactPreview,
  RadioGroup,
  Stack,
  SwitchField,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminOrg } from "../lib/admin";
import { ApiClientError } from "../lib/api";
import {
  type CatalogItem,
  displayNameOf,
  ownerOrgOf,
  PLUGIN_SCOPES,
  type PluginScope,
  previewScope,
  type ScopeConflict,
  type ScopePreview,
  setDisabled,
  setScope,
  setShownToOthers,
  shareGated,
  type ThemePreview,
} from "../lib/catalog";
import { adminOrgsQuery } from "../lib/query/admin";
import { pluginScopeChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { useAdminThemeName, useThemeImpactGroup } from "./ThemeImpact";

/** The deployment's orgs for the scope pickers (a section: empty while it loads or failed). */
function useOrgs(): AdminOrg[] {
  const oq = adminOrgsQuery();
  return useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
}

/** A scope choice: one of the scopes, or (a component of a plugin) following its plugin's. */
export type ScopeChoice = PluginScope | "follow";

/**
 * The scope picker (spec §5): 全部组织启用 / 组织自选 / 指定组织, and for 指定组织 one checkbox
 * per org. Shared by the 设置范围 dialogs (plugins and components) and the import review's confirm
 * step. `follow` adds 跟随插件 first (a component of a plugin, spec §5 rule 2). `owner`: the org
 * that owns the item, always listed (409 `catalog.owner_required`, ruling P3-17). `narrowTo`: an
 * org-owned item its org does not share (ruling P3-16): 指定组织 only, and only these orgs, so the
 * change can only remove orgs.
 */
export function ScopeFields({
  scope,
  orgs,
  onScope,
  onOrgs,
  disabled,
  follow,
  owner,
  narrowTo,
}: {
  scope: ScopeChoice;
  orgs: string[];
  onScope(next: PluginScope): void;
  onOrgs(next: string[]): void;
  disabled?: boolean;
  follow?: { label: string; description: string; onSelect(): void };
  owner?: string;
  narrowTo?: string[];
}) {
  const t = useTranslations("catalog");
  const deployment = useOrgs();
  const all =
    narrowTo === undefined ? deployment : deployment.filter((o) => narrowTo.includes(o.id));
  if (narrowTo !== undefined) {
    return (
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("admin.scopeDialog.narrowOnly")}
        </Text>
        <OrgChecks
          all={all}
          orgs={orgs}
          onOrgs={onOrgs}
          {...(disabled ? { disabled } : {})}
          {...(owner !== undefined ? { owner } : {})}
        />
      </Stack>
    );
  }
  return (
    <Stack gap={12}>
      <RadioGroup
        label={t("admin.scopeDialog.scopeLabel")}
        value={scope}
        onChange={(v) => (v === "follow" ? follow?.onSelect() : onScope(v as PluginScope))}
        {...(disabled ? { disabled } : {})}
        options={[
          ...(follow
            ? [{ value: "follow", label: follow.label, description: follow.description }]
            : []),
          ...PLUGIN_SCOPES.map((s) => ({
            value: s,
            label: t(`scope.${s}`),
            description: t(`admin.scopeDialog.hints.${s}`),
          })),
        ]}
      />
      {scope === "named" && (
        <OrgChecks
          all={all}
          orgs={orgs}
          onOrgs={onOrgs}
          {...(disabled ? { disabled } : {})}
          {...(owner !== undefined ? { owner } : {})}
        />
      )}
    </Stack>
  );
}

/** 指定组织's checkboxes: one per org; the owner org's is checked and cannot be cleared. */
function OrgChecks({
  all,
  orgs,
  onOrgs,
  disabled,
  owner,
}: {
  all: AdminOrg[];
  orgs: string[];
  onOrgs(next: string[]): void;
  disabled?: boolean;
  owner?: string;
}) {
  const t = useTranslations("catalog");
  return (
    <Field
      label={t("admin.scopeDialog.orgsLabel")}
      {...(owner !== undefined ? { help: t("admin.scopeDialog.ownerKept") } : {})}
    >
      <Stack gap={8}>
        {all.length === 0 && (
          <Text variant="small" tone="muted">
            {t("admin.scopeDialog.orgsNone")}
          </Text>
        )}
        {all.map((o) => (
          <Checkbox
            key={o.id}
            label={o.name}
            checked={o.id === owner || orgs.includes(o.id)}
            {...(disabled || o.id === owner ? { disabled: true } : {})}
            onChange={(on) => onOrgs(on ? [...orgs, o.id] : orgs.filter((id) => id !== o.id))}
          />
        ))}
      </Stack>
    </Field>
  );
}

/** What a scope preview lists (a plugin's `ScopePreview`, a component's `ComponentScopePreview`). */
export interface ScopeImpactPreview {
  affected: ScopePreview["affected"];
  needsConfig?: string[];
  replaced?: { kind: string; id: string; name: string }[];
  conflicts?: ScopeConflict[];
  /** The themes the change takes away (themes spec §6). */
  themes?: ThemePreview[];
}

/** The change is refused while an org would be offered a skill whose name it already uses. */
export const hasConflicts = (p: ScopeImpactPreview | null): boolean =>
  (p?.conflicts?.length ?? 0) > 0;

/**
 * What a scope change or a disable takes away (spec §5 rules 2, 8 and 10): each affected org with
 * the agents that use it and the connectors it keeps as its own, the orgs that must fill in its
 * org config first, the components whose own scope a plugin's change replaces, and the name
 * clashes that refuse the change.
 */
export function ScopeImpact({ preview }: { preview: ScopeImpactPreview }) {
  const t = useTranslations("catalog.admin.impact");
  const locale = useLocale();
  const orgs = useOrgs();
  const sep = locale === "zh" ? "、" : ", ";
  const nameOf = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;
  const needsConfig = preview.needsConfig ?? [];
  const replaced = preview.replaced ?? [];
  const conflicts = preview.conflicts ?? [];
  const themeGroup = useThemeImpactGroup(preview.themes, useAdminThemeName());
  return (
    <Stack gap={16}>
      {conflicts.length > 0 && <Callout tone="fail">{t("conflicts")}</Callout>}
      <ImpactPreview
        empty={t("none")}
        groups={[
          {
            id: "affected",
            title: t("groups.affected"),
            items: preview.affected.map((a) => ({
              id: a.orgId,
              title: a.orgName,
              notes: [
                {
                  text:
                    a.agents.length === 0
                      ? t("noAgents")
                      : t("agents", { names: a.agents.map((g) => g.name).join(sep) }),
                },
                ...(a.connectorsKept > 0
                  ? [{ text: t("connectorsKept", { count: a.connectorsKept }) }]
                  : []),
              ],
            })),
            empty: t("none"),
          },
          {
            id: "needsConfig",
            title: t("groups.needsConfig"),
            items: needsConfig.map((id) => ({ id, title: nameOf(id) })),
          },
          {
            id: "replaced",
            title: t("groups.replaced"),
            description: t("replaced"),
            items: replaced.map((r) => ({ id: `${r.kind}:${r.id}`, title: r.name })),
          },
          {
            id: "conflicts",
            title: t("groups.conflicts"),
            items: conflicts.map((c) => ({
              id: `${c.orgId}:${c.name}`,
              title: c.orgName,
              notes: [{ text: t("conflictNote", { name: c.name }), tone: "fail" as const }],
            })),
          },
          ...(themeGroup === null ? [] : [themeGroup]),
        ]}
      />
    </Stack>
  );
}

/** A scope change (`orgs` only with 指定组织). */
type ScopeChange = { scope: PluginScope; orgs?: string[] };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The `named` list with the owner org first in it (it is never removed, ruling P3-17). */
export const withOwner = (orgs: string[], owner: string | undefined): string[] =>
  owner === undefined || orgs.includes(owner) ? orgs : [owner, ...orgs];

/**
 * 设置范围 (spec §5, §9): pick the scope (and the orgs of 指定组织, with 对其他组织显示), then the
 * impact preview (`previewScope`), then confirm with its `scopeHash` (a changed impact meanwhile is
 * 409 `plugin.scope_stale`: preview again). Never offered for a built-in plugin.
 */
export function PluginScopeDialog({
  item,
  orgId,
  onClose,
}: {
  item: CatalogItem;
  /** The current org (its cached catalog is read again), null without one. */
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("catalog.admin.scopeDialog");
  const tr = useTranslations("catalog.admin.review");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const owner = ownerOrgOf(item)?.orgId;
  // An org-owned item its org does not share only narrows (ruling P3-16)
  const narrow = shareGated(item);
  const [scope, setScopeChoice] = useState<PluginScope>(narrow ? "named" : item.scope);
  const [orgs, setOrgs] = useState<string[]>(withOwner(item.scopeOrgs, owner));
  const [shown, setShown] = useState(item.shownToOthers);
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** The scope part is saved (a retry after a failed 对其他组织显示 sends only that). */
  const [scopeSaved, setScopeSaved] = useState(false);
  const target = (): ScopeChange => (scope === "named" ? { scope, orgs } : { scope });
  const previewIt = useAppMutation({
    fn: (body: ScopeChange) => previewScope(item.id, body),
    invalidates: () => [],
  });
  const saveScope = useAppMutation({
    fn: (body: ScopeChange & { scopeHash: string }) => setScope(item.id, body),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  const saveShown = useAppMutation({
    fn: (next: boolean) => setShownToOthers(item.id, next),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  const scopeChanged =
    scope !== item.scope || (scope === "named" && !sameSet(orgs, item.scopeOrgs));
  const shownChanged = !narrow && scope === "named" && shown !== item.shownToOthers;
  const unchanged = !scopeChanged && !shownChanged;
  const invalid = scope === "named" && orgs.length === 0;
  const saving = saveScope.isPending || saveShown.isPending || previewIt.isPending;

  const next = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      setPreview(await previewIt.mutateAsync(target()));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const confirm = async () => {
    if (preview === null) return;
    setError(undefined);
    setNotice(undefined);
    try {
      if (scopeChanged && !scopeSaved) {
        await saveScope.mutateAsync({ ...target(), scopeHash: preview.scopeHash });
        setScopeSaved(true);
      }
      if (shownChanged) await saveShown.mutateAsync(shown);
      toast.success(t("saved", { name: displayNameOf(item, locale) }));
      onClose();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "plugin.scope_stale") {
        // The impact moved on: show the new one and let the person confirm again
        await next();
        setNotice(t("stale"));
      } else setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: displayNameOf(item, locale) })}
      size={640}
      footer={
        preview === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={previewIt.isPending}
              disabled={unchanged || invalid || previewIt.isPending}
              onClick={() => void next()}
            >
              {t("next")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setPreview(null);
                setError(undefined);
                setNotice(undefined);
              }}
            >
              {t("back")}
            </Button>
            <Button
              variant="primary"
              loading={saveScope.isPending || saveShown.isPending}
              disabled={saving || hasConflicts(preview)}
              onClick={() => void confirm()}
            >
              {t("confirm")}
            </Button>
          </>
        )
      }
    >
      <Stack gap={16}>
        {preview === null ? (
          <>
            <ScopeFields
              scope={scope}
              orgs={orgs}
              onScope={setScopeChoice}
              onOrgs={setOrgs}
              {...(owner !== undefined ? { owner } : {})}
              {...(narrow ? { narrowTo: item.scopeOrgs } : {})}
            />
            {scope === "named" && !narrow && (
              <Stack gap={4}>
                <SwitchField label={t("shown")} checked={shown} onChange={setShown} />
                <Text variant="small" tone="muted">
                  {t("shownHint")}
                </Text>
              </Stack>
            )}
            {invalid && (
              <Text variant="small" tone="muted">
                {tr("namedNeedsOrg")}
              </Text>
            )}
          </>
        ) : (
          <>
            {notice !== undefined && <Callout tone="warn">{notice}</Callout>}
            <ScopeImpact preview={preview} />
          </>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/**
 * 停用 (spec §5 rule 4): the impact of a deployment-wide disable (`previewScope({ disabled:
 * true })`), confirmed with its `scopeHash`. The scope is kept for a later 启用.
 */
export function PluginDisableDialog({
  item,
  orgId,
  onClose,
}: {
  item: CatalogItem;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("catalog.admin");
  const locale = useLocale();
  const name = displayNameOf(item, locale);
  const preview = useAppMutation({
    fn: () => previewScope(item.id, { disabled: true }),
    invalidates: () => [],
  });
  const disable = useAppMutation({
    fn: (hash: string) => setDisabled(item.id, { disabled: true, scopeHash: hash }),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  return (
    <ImpactDisableDialog
      title={t("disableDialog.title", { name })}
      hint={t("disableDialog.hint")}
      confirmLabel={t("disableDialog.confirm")}
      doneToast={t("detail.disabledToast", { name })}
      preview={preview}
      disable={disable}
      onClose={onClose}
    />
  );
}

/**
 * A disable dialog with its impact (plugins and platform components): `preview` (the caller's
 * mutation reading the `{ disabled: true }` preview) runs when it opens, the confirm sends its
 * `scopeHash`; a 409 `plugin.scope_stale` reads it again.
 */
export function ImpactDisableDialog({
  title,
  hint,
  confirmLabel,
  doneToast,
  preview: previewIt,
  disable,
  onClose,
}: {
  title: string;
  hint: string;
  confirmLabel: string;
  doneToast: string;
  preview: { mutateAsync(v: undefined): Promise<ScopeImpactPreview & { scopeHash: string }> };
  disable: { mutateAsync(hash: string): Promise<unknown>; isPending: boolean };
  onClose(): void;
}) {
  const t = useTranslations("catalog.admin");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [preview, setPreview] = useState<(ScopeImpactPreview & { scopeHash: string }) | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const asked = useRef(false);
  const { mutateAsync: ask } = previewIt;
  const load = useCallback(
    () =>
      ask(undefined).then(
        (p) => setPreview(p),
        (e: unknown) => setError(errorMessage(e)),
      ),
    [ask, errorMessage],
  );
  // The impact is read when the dialog opens (and again when it went stale)
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
      await disable.mutateAsync(preview.scopeHash);
      toast.success(doneToast);
      onClose();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "plugin.scope_stale") {
        setPreview(null);
        await load();
        setNotice(t("scopeDialog.stale"));
      } else setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("scopeDialog.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={disable.isPending}
            disabled={preview === null || disable.isPending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{hint}</Text>
        {notice !== undefined && <Callout tone="warn">{notice}</Callout>}
        {preview !== null && <ScopeImpact preview={preview} />}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
