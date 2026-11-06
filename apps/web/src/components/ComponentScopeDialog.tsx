"use client";

import {
  AttachmentChip,
  Button,
  Dialog,
  FilePicker,
  Stack,
  SwitchField,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError } from "../lib/api";
import type { PluginScope } from "../lib/catalog";
import {
  type ComponentScopePreview,
  moveTo,
  type PlatformComponent,
  previewComponentScope,
  setComponentDisabled,
  setComponentScope,
  setComponentShown,
  shareBlockOf,
  uploadAgentTemplateVersion,
  uploadSkillVersion,
} from "../lib/components";
import { componentChangeKeys } from "../lib/query/components";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import {
  hasConflicts,
  ImpactDisableDialog,
  type ScopeChoice,
  ScopeFields,
  ScopeImpact,
  withOwner,
} from "./PluginScopeDialog";

/** A component scope change: its own scope (`orgs` only with 指定组织) or following its plugin. */
type Target = { scope: PluginScope; orgs?: string[] } | { follow: true };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * 设置范围 of a platform component (spec §5 rules 2, 8, 10): 跟随插件 (a component of a plugin)
 * or its own scope with the orgs of 指定组织 and 对其他组织显示, then the impact preview (agents
 * losing it, connectors kept, name clashes, which refuse the change), then confirm with its
 * `scopeHash` (409 `plugin.scope_stale`: preview again). An org-owned component keeps its owner
 * listed; one its org does not share only narrows (ruling P3-16).
 */
export function ComponentScopeDialog({
  component: c,
  orgId,
  onClose,
}: {
  component: PlatformComponent;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("adminComponents.scopeDialog");
  const ts = useTranslations("catalog.admin.scopeDialog");
  const tr = useTranslations("catalog.admin.review");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const owner = c.owner.kind === "org" ? c.owner.orgId : undefined;
  // An org-owned component its org does not share (or may not share) only narrows (P3-16, P3-46)
  const narrow = shareBlockOf(c) !== null;
  const canFollow = c.itemId !== null && !narrow;
  const [choice, setChoice] = useState<ScopeChoice>(
    narrow ? "named" : c.scopeMode === "follow" && canFollow ? "follow" : c.scope,
  );
  const [orgs, setOrgs] = useState<string[]>(withOwner(c.scope === "named" ? c.orgs : [], owner));
  const [shown, setShown] = useState(c.shownToOthers);
  const [preview, setPreview] = useState<ComponentScopePreview | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [scopeSaved, setScopeSaved] = useState(false);
  const target = (): Target =>
    choice === "follow"
      ? { follow: true }
      : choice === "named"
        ? { scope: choice, orgs }
        : { scope: choice };
  const previewIt = useAppMutation({
    fn: (body: Target) => previewComponentScope(c.kind, c.id, body),
    invalidates: () => [],
  });
  const saveScope = useAppMutation({
    fn: (body: Target & { scopeHash: string }) => setComponentScope(c.kind, c.id, body),
    invalidates: () => componentChangeKeys(orgId),
  });
  const saveShown = useAppMutation({
    fn: (v: { id: string; next: boolean }) => setComponentShown(c.kind, v.id, v.next),
    invalidates: () => componentChangeKeys(orgId),
  });
  const own = c.scopeMode === "own" || !canFollow;
  const scopeChanged =
    choice === "follow"
      ? own
      : !own || choice !== c.scope || (choice === "named" && !sameSet(orgs, c.orgs));
  const shownChanged = !narrow && choice === "named" && shown !== c.shownToOthers;
  const unchanged = !scopeChanged && !shownChanged;
  const invalid = choice === "named" && orgs.length === 0;
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
      // An org row is promoted by a change that shows or associates it: later calls and the page
      // use the platform id it answers with (ruling P3-23)
      let now = c;
      if (scopeChanged && !scopeSaved) {
        now = await saveScope.mutateAsync({ ...target(), scopeHash: preview.scopeHash });
        setScopeSaved(true);
      }
      if (shownChanged) now = await saveShown.mutateAsync({ id: now.id, next: shown });
      toast.success(t("saved", { name: c.name }));
      onClose();
      moveTo(router, c, now);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "plugin.scope_stale") {
        await next();
        setNotice(ts("stale"));
      } else setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: c.name })}
      size={640}
      footer={
        preview === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {ts("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={previewIt.isPending}
              disabled={unchanged || invalid || previewIt.isPending}
              onClick={() => void next()}
            >
              {ts("next")}
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
              {ts("back")}
            </Button>
            <Button
              variant="primary"
              loading={saveScope.isPending || saveShown.isPending}
              disabled={saving || hasConflicts(preview)}
              onClick={() => void confirm()}
            >
              {ts("confirm")}
            </Button>
          </>
        )
      }
    >
      <Stack gap={16}>
        {preview === null ? (
          <>
            <ScopeFields
              scope={choice}
              orgs={orgs}
              onScope={setChoice}
              onOrgs={setOrgs}
              {...(owner !== undefined ? { owner } : {})}
              {...(narrow ? { narrowTo: c.orgs } : {})}
              {...(canFollow
                ? {
                    follow: {
                      label: t("follow"),
                      description: t("followHint", { plugin: c.plugin ?? "" }),
                      onSelect: () => setChoice("follow"),
                    },
                  }
                : {})}
            />
            {choice === "named" && !narrow && (
              <Stack gap={4}>
                <SwitchField label={ts("shown")} checked={shown} onChange={setShown} />
                <Text variant="small" tone="muted">
                  {ts("shownHint")}
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

/** 停用 of a platform component: its impact, confirmed with the preview's `scopeHash`. */
export function ComponentDisableDialog({
  component: c,
  orgId,
  onClose,
}: {
  component: PlatformComponent;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("adminComponents");
  const preview = useAppMutation({
    fn: () => previewComponentScope(c.kind, c.id, { disabled: true }),
    invalidates: () => [],
  });
  const disable = useAppMutation({
    fn: (hash: string) => setComponentDisabled(c.kind, c.id, { disabled: true, scopeHash: hash }),
    invalidates: () => componentChangeKeys(orgId),
  });
  return (
    <ImpactDisableDialog
      title={t("disableDialog.title", { name: c.name })}
      hint={t("disableDialog.hint")}
      confirmLabel={t("disableDialog.confirm")}
      doneToast={t("detail.disabledToast", { name: c.name })}
      preview={preview}
      disable={disable}
      onClose={onClose}
    />
  );
}

/**
 * 上传新版本 of a platform skill (its .zip, sent as the raw body) or agent template (its .md, sent
 * as `{ content }`), spec §7.2: the next version, flagged as updated on its own.
 */
export function ComponentUploadDialog({
  component: c,
  orgId,
  onClose,
}: {
  component: PlatformComponent;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("adminComponents.upload");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string>();
  const skill = c.kind === "skill";
  const upload = useAppMutation({
    fn: async (f: File) =>
      skill ? uploadSkillVersion(c.id, f) : uploadAgentTemplateVersion(c.id, await f.text()),
    invalidates: () => componentChangeKeys(orgId),
  });
  const submit = async () => {
    if (file === null) return;
    setError(undefined);
    try {
      const r = await upload.mutateAsync(file);
      toast.success(t("done", { name: c.name, version: versionLabel(String(r.version)) }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: c.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={upload.isPending}
            disabled={file === null || upload.isPending}
            onClick={() => void submit()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">
          {skill ? t("skillHint", { name: c.name }) : t("templateHint", { name: c.name })}
        </Text>
        <FilePicker
          label={t("choose")}
          dropLabel={t("drop")}
          accept={skill ? ".zip,application/zip" : ".md,text/markdown"}
          disabled={upload.isPending}
          onFiles={(files) => {
            setFile(files[0] ?? null);
            setError(undefined);
          }}
        >
          {file !== null && (
            <AttachmentChip
              name={file.name}
              size={file.size}
              status="ready"
              onRemove={() => setFile(null)}
            />
          )}
        </FilePicker>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
