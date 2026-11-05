"use client";

import {
  Button,
  Checkbox,
  Dialog,
  Field,
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
  PLUGIN_SCOPES,
  type PluginScope,
  previewScope,
  type ScopePreview,
  setDisabled,
  setScope,
  setShownToOthers,
} from "../lib/catalog";
import { adminOrgsQuery } from "../lib/query/admin";
import { pluginScopeChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** The deployment's orgs for the scope pickers (a section: empty while it loads or failed). */
function useOrgs(): AdminOrg[] {
  const oq = adminOrgsQuery();
  return useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs ?? [];
}

/**
 * The scope picker (spec §5): 全部组织启用 / 组织自选 / 指定组织, and for 指定组织 one checkbox
 * per org. Shared by the 设置范围 dialog and the import review's confirm step.
 */
export function ScopeFields({
  scope,
  orgs,
  onScope,
  onOrgs,
  disabled,
}: {
  scope: PluginScope;
  orgs: string[];
  onScope(next: PluginScope): void;
  onOrgs(next: string[]): void;
  disabled?: boolean;
}) {
  const t = useTranslations("catalog");
  const all = useOrgs();
  return (
    <Stack gap={12}>
      <RadioGroup
        label={t("admin.scopeDialog.scopeLabel")}
        value={scope}
        onChange={(v) => onScope(v as PluginScope)}
        {...(disabled ? { disabled } : {})}
        options={PLUGIN_SCOPES.map((s) => ({
          value: s,
          label: t(`scope.${s}`),
          description: t(`admin.scopeDialog.hints.${s}`),
        }))}
      />
      {scope === "named" && (
        <Field label={t("admin.scopeDialog.orgsLabel")}>
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
                checked={orgs.includes(o.id)}
                {...(disabled ? { disabled } : {})}
                onChange={(on) => onOrgs(on ? [...orgs, o.id] : orgs.filter((id) => id !== o.id))}
              />
            ))}
          </Stack>
        </Field>
      )}
    </Stack>
  );
}

/**
 * What a scope change or a disable takes away (spec §5 rule 8): each affected org with the agents
 * that use the plugin, and the orgs that must fill in its org config first.
 */
export function ScopeImpact({ preview }: { preview: ScopePreview }) {
  const t = useTranslations("catalog.admin.impact");
  const locale = useLocale();
  const orgs = useOrgs();
  const sep = locale === "zh" ? "、" : ", ";
  const nameOf = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;
  if (preview.affected.length === 0 && preview.needsConfig.length === 0) {
    return <Text variant="prose">{t("none")}</Text>;
  }
  return (
    <Stack gap={12}>
      {preview.affected.length > 0 && (
        <Stack gap={8}>
          <Text variant="prose">{t("affected")}</Text>
          {preview.affected.map((a) => (
            <Stack key={a.orgId} gap={4}>
              <Text>{a.orgName}</Text>
              <Text variant="small" tone="muted">
                {a.agents.length === 0
                  ? t("noAgents")
                  : t("agents", { names: a.agents.map((g) => g.name).join(sep) })}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
      {preview.needsConfig.length > 0 && (
        <Text variant="prose" tone="warn">
          {t("needsConfig", { orgs: preview.needsConfig.map(nameOf).join(sep) })}
        </Text>
      )}
    </Stack>
  );
}

/** A scope change (`orgs` only with 指定组织). */
type ScopeChange = { scope: PluginScope; orgs?: string[] };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

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
  const [scope, setScopeChoice] = useState<PluginScope>(item.scope);
  const [orgs, setOrgs] = useState<string[]>(item.scopeOrgs);
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
  const shownChanged = scope === "named" && shown !== item.shownToOthers;
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
              disabled={saving}
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
            <ScopeFields scope={scope} orgs={orgs} onScope={setScopeChoice} onOrgs={setOrgs} />
            {scope === "named" && (
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
            {notice !== undefined && (
              <Text variant="prose" tone="warn">
                {notice}
              </Text>
            )}
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
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const name = displayNameOf(item, locale);
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const asked = useRef(false);
  const previewIt = useAppMutation({
    fn: () => previewScope(item.id, { disabled: true }),
    invalidates: () => [],
  });
  const disable = useAppMutation({
    fn: (hash: string) => setDisabled(item.id, { disabled: true, scopeHash: hash }),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
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
      toast.success(t("detail.disabledToast", { name }));
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
      title={t("disableDialog.title", { name })}
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
            {t("disableDialog.confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("disableDialog.hint")}</Text>
        {notice !== undefined && (
          <Text variant="prose" tone="warn">
            {notice}
          </Text>
        )}
        {preview !== null && <ScopeImpact preview={preview} />}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
