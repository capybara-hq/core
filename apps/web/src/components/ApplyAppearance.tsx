"use client";

import {
  Button,
  Dialog,
  ItemList,
  type ItemListRow,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  type AppearanceResult,
  type AppearanceSkipReason,
  appearanceUnchanged,
  applyOrgAppearance,
  applyPlatformAppearance,
} from "../lib/appearance";
import { componentName } from "../lib/components";
import { retryOnMountOf } from "../lib/query/client";
import { invalidateClientSets } from "../lib/query/client-extensions";
import { adminComponentsQuery } from "../lib/query/components";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { invalidatePlatformTheme, orgThemesQuery } from "../lib/query/themes";
import { adminUiArrangementQuery, invalidateOrgUiLists, uiArrangementQuery } from "../lib/query/ui";
import { themeName } from "../lib/themes";
import { isSingleArrangementSlot, uiLocale } from "../lib/ui";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { useSlotName } from "./UiArrangementSection";

/**
 * Where 应用此插件的外观 writes (client extensions spec §6.5): the platform defaults (the super
 * admin, on the admin plugin detail: the catalog item) or one org's (an org admin, on the 扩展 page:
 * the extension, on in the org).
 */
export type AppearanceLevel =
  | { kind: "platform"; itemId: string }
  | { kind: "org"; orgId: string; extension: string };

/** The message key of a skip reason (a message path holds no `-`). */
const REASON_KEY: Record<AppearanceSkipReason, string> = {
  "unknown-slot": "unknownSlot",
  "not-available": "notAvailable",
  "not-eligible": "notEligible",
};

/**
 * 应用此插件的外观: `preview()` asks the kernel what would change (`dryRun: true`, nothing written)
 * and opens the confirm dialog listing it; confirming applies it (`dryRun: false`). Callers show
 * the action only when the plugin suggests an appearance and the viewer may write the level
 * (members never see it). `dialog` is rendered by the caller.
 */
export function useApplyAppearance(
  level: AppearanceLevel,
  name: string,
): { preview(): void; previewing: boolean; dialog: ReactNode } {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [result, setResult] = useState<AppearanceResult | null>(null);
  const dry = useAppMutation({
    fn: () =>
      level.kind === "platform"
        ? applyPlatformAppearance(level.itemId, true)
        : applyOrgAppearance(level.orgId, level.extension, true),
    invalidates: () => [],
  });
  const preview = () => {
    dry.mutateAsync(undefined).then(setResult, (e: unknown) => toast.error(errorMessage(e)));
  };
  return {
    preview,
    previewing: dry.isPending,
    dialog:
      result === null ? null : (
        <ApplyAppearanceDialog
          level={level}
          name={name}
          result={result}
          onClose={() => setResult(null)}
        />
      ),
  };
}

/**
 * The confirm dialog: the changes of the dry run in the order the kernel answers (the plugin's),
 * each as `from → to` with names (the theme's, the slot's, the contribution's), then what is
 * skipped and why. Nothing to change: one 知道了.
 */
function ApplyAppearanceDialog({
  level,
  name,
  result,
  onClose,
}: {
  level: AppearanceLevel;
  name: string;
  result: AppearanceResult;
  onClose(): void;
}) {
  const t = useTranslations("applyAppearance");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const names = useNames(level);
  const slotName = useSlotName();
  const [error, setError] = useState<string>();
  const write = useAppMutation({
    fn: async () => {
      const r =
        level.kind === "platform"
          ? await applyPlatformAppearance(level.itemId, false)
          : await applyOrgAppearance(level.orgId, level.extension, false);
      if (level.kind === "platform") {
        // the platform defaults: every org follows them until it picks its own
        await Promise.all([
          invalidatePlatformTheme(qc),
          invalidateOrgUiLists(qc),
          invalidateClientSets(qc),
        ]);
      }
      return r;
    },
    invalidates: () =>
      level.kind === "platform"
        ? [
            keys.deployment().settings(),
            keys.deployment().uiArrangement(),
            keys.deployment().uiContributions(),
            keys.deployment().components("theme"),
          ]
        : [
            keys.org(level.orgId).themes(),
            keys.org(level.orgId).orgSettings(),
            keys.org(level.orgId).uiArrangement(),
            keys.org(level.orgId).contributions(),
            keys.org(level.orgId).extensionPages(),
            keys.org(level.orgId).clientExtensions(),
          ],
  });
  const unchanged = appearanceUnchanged(result);
  const rows: ItemListRow[] = [
    ...(result.theme === null
      ? []
      : [
          {
            id: "theme",
            title: t("theme"),
            meta: t("change", {
              from: result.theme.from === null ? t("builtinTheme") : names.theme(result.theme.from),
              to: names.theme(result.theme.to),
            }),
          },
        ]),
    ...result.replacements.map((r) => ({
      id: `slot:${r.slot}`,
      title: slotName(r.slot),
      meta: t("change", {
        from: r.from === null ? t("builtin") : names.contribution(r.from),
        to: names.contribution(r.to),
      }),
    })),
    ...result.skipped.map((s) => ({
      id: `skipped:${s.what}`,
      title: t("skipped", { what: slotName(s.what) }),
      meta: t(`reason.${REASON_KEY[s.reason]}`),
    })),
  ];

  async function confirm() {
    setError(undefined);
    try {
      await write.mutateAsync(undefined);
      toast.success(t("applied", { name }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name })}
      size={640}
      footer={
        unchanged ? (
          <Button variant="primary" onClick={onClose}>
            {t("ok")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={write.isPending}
              disabled={write.isPending}
              onClick={() => void confirm()}
            >
              {t("apply")}
            </Button>
          </>
        )
      }
    >
      <Stack gap={12}>
        <Text variant="prose">
          {unchanged ? t("unchanged") : t(level.kind === "platform" ? "platformHint" : "orgHint")}
        </Text>
        <ItemList label={t("changes")} rows={rows} />
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/**
 * Display names for the dialog: a theme by its id (the level's theme list), a contribution by its
 * key (the level's arrangement candidates); the raw id or key when not listed.
 */
function useNames(level: AppearanceLevel): {
  theme(id: string): string;
  contribution(key: string): string;
} {
  const locale = useLocale();
  const ui = uiLocale(locale);
  const tq = level.kind === "platform" ? adminComponentsQuery("theme") : null;
  const platformThemes = useQuery({
    ...(tq ?? adminComponentsQuery("theme")),
    enabled: tq !== null,
    retryOnMount: tq === null ? false : retryOnMountOf(tq.queryKey),
  }).data?.components;
  const oq = level.kind === "org" ? orgThemesQuery(level.orgId) : null;
  const orgThemes = useQuery({
    ...(oq ?? orgThemesQuery("")),
    enabled: oq !== null,
    retryOnMount: oq === null ? false : retryOnMountOf(oq.queryKey),
  }).data?.themes;
  const aq =
    level.kind === "platform" ? adminUiArrangementQuery() : uiArrangementQuery(level.orgId);
  const slots = useQuery({ ...aq, retryOnMount: retryOnMountOf(aq.queryKey) }).data ?? [];
  const titles = new Map(
    slots.flatMap((s) =>
      isSingleArrangementSlot(s) ? s.candidates.map((c) => [c.key, c.title[ui]] as const) : [],
    ),
  );
  return {
    theme: (id) => {
      const p = platformThemes?.find((c) => c.id === id);
      if (p !== undefined) return componentName(p, locale);
      const o = orgThemes?.find((x) => x.id === id);
      return o === undefined ? id : themeName(o, locale);
    },
    contribution: (key) => titles.get(key) ?? key,
  };
}

/**
 * The action as a button with its hint (the org's extension Sheet): 应用此插件的外观 and the
 * confirm dialog it opens.
 */
export function ApplyAppearanceAction({ level, name }: { level: AppearanceLevel; name: string }) {
  const t = useTranslations("applyAppearance");
  const { preview, previewing, dialog } = useApplyAppearance(level, name);
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t(level.kind === "platform" ? "actionHintPlatform" : "actionHintOrg")}
      </Text>
      <Stack direction="row">
        <Button
          loading={previewing}
          disabled={previewing}
          aria-label={t("actionLabel", { name })}
          onClick={preview}
        >
          {t("action")}
        </Button>
      </Stack>
      {dialog}
    </Stack>
  );
}
