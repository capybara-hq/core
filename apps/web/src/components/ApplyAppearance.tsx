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
import { ApiClientError } from "../lib/api";
import {
  type AppearanceResult,
  type AppearanceSkipReason,
  appearanceUnchanged,
  applyOrgAppearance,
  applyPlatformAppearance,
} from "../lib/appearance";
import { reloadDocument } from "../lib/browser";
import { componentName } from "../lib/components";
import { retryOnMountOf } from "../lib/query/client";
import { invalidateClientSets } from "../lib/query/client-extensions";
import { adminComponentsQuery } from "../lib/query/components";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { invalidatePlatformTheme, orgThemesQuery } from "../lib/query/themes";
import { adminUiArrangementQuery, invalidateOrgUiLists, uiArrangementQuery } from "../lib/query/ui";
import { themeName, themeOffOrgs } from "../lib/themes";
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
 *
 * `clientCode`: the plugin ships client code (its running build). A loaded document never picks up
 * new client code (client extensions spec §9.6), so after a successful apply the page reloads and
 * the replacements, the plugin's stylesheets and its overlay show at once; the dialog says so.
 */
export function useApplyAppearance(
  level: AppearanceLevel,
  name: string,
  clientCode = false,
): { preview(): void; previewing: boolean; dialog: ReactNode } {
  const toast = useToast();
  const qc = useQueryClient();
  const appearanceError = useAppearanceError(level);
  const [result, setResult] = useState<AppearanceResult | null>(null);
  const dry = useAppMutation({
    fn: async () => {
      // the names the dialog shows (themes, contributions) are read with the dry run, so the
      // dialog opens with names, never raw ids
      const [r] = await Promise.all([
        level.kind === "platform"
          ? applyPlatformAppearance(level.itemId, true)
          : applyOrgAppearance(level.orgId, level.extension, true),
        ...(level.kind === "platform"
          ? [
              qc.prefetchQuery({ ...adminComponentsQuery("theme"), retry: false }),
              qc.prefetchQuery({ ...adminUiArrangementQuery(), retry: false }),
            ]
          : [
              qc.prefetchQuery({ ...orgThemesQuery(level.orgId), retry: false }),
              qc.prefetchQuery({ ...uiArrangementQuery(level.orgId), retry: false }),
            ]),
      ]);
      return r;
    },
    invalidates: () => [],
  });
  const preview = () => {
    dry.mutateAsync(undefined).then(setResult, (e: unknown) => toast.error(appearanceError(e)));
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
          clientCode={clientCode}
          onClose={() => setResult(null)}
        />
      ),
  };
}

/**
 * The confirm dialog: the changes of the dry run in the order the kernel answers (the plugin's),
 * each as `from → to` with names (the theme's, the slot's, the contribution's), then what is
 * skipped and why. Nothing to change: one 知道了. With client code it says the page reloads after
 * the apply, and reloads it.
 */
function ApplyAppearanceDialog({
  level,
  name,
  result,
  clientCode,
  onClose,
}: {
  level: AppearanceLevel;
  name: string;
  result: AppearanceResult;
  clientCode: boolean;
  onClose(): void;
}) {
  const t = useTranslations("applyAppearance");
  const tc = useTranslations("common");
  const toast = useToast();
  const appearanceError = useAppearanceError(level);
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
  // An org following the platform's value: the current value is said to be the platform's
  const current = (name: string, follows: boolean | undefined) =>
    follows === true ? t("followsPlatform", { name }) : name;
  const rows: ItemListRow[] = [
    ...(result.theme === null
      ? []
      : [
          {
            id: "theme",
            title: t("theme"),
            meta: t("change", {
              from: current(
                result.theme.from === null ? t("builtinTheme") : names.theme(result.theme.from),
                result.theme.followsPlatform,
              ),
              to: names.theme(result.theme.to),
            }),
          },
        ]),
    ...result.replacements.map((r) => ({
      id: `slot:${r.slot}`,
      title: slotName(r.slot),
      meta: t("change", {
        from: current(
          r.from === null ? t("builtin") : names.contribution(r.from),
          r.followsPlatform,
        ),
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
      // the document's client code is fixed (spec §9.6): a new document loads the plugin's
      if (clientCode) reloadDocument();
    } catch (e) {
      setError(appearanceError(e));
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
        {!unchanged && clientCode && <Text variant="prose">{t("reloadHint")}</Text>}
        <ItemList label={t("changes")} rows={rows} />
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/**
 * The message of a refused dry run or apply: a theme that cannot be set (`theme.not_available`)
 * says what to do at the level (the platform: the orgs where the theme is off, or that the plugin
 * must be offered to every org; an org: switch the theme on or ask the super admin); anything else
 * by its code.
 */
function useAppearanceError(level: AppearanceLevel): (e: unknown) => string {
  const t = useTranslations("applyAppearance.errors");
  const ta = useTranslations("appearance.platform");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  return (e) => {
    if (!(e instanceof ApiClientError) || e.code !== "theme.not_available") return errorMessage(e);
    if (level.kind === "org") return t("orgTheme");
    const off = themeOffOrgs(e);
    return off.length > 0
      ? ta("notAvailable", { orgs: off.join(locale === "zh" ? "、" : ", ") })
      : t("platformTheme");
  };
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
 * confirm dialog it opens; `clientCode` as for {@link useApplyAppearance}.
 */
export function ApplyAppearanceAction({
  level,
  name,
  clientCode = false,
}: {
  level: AppearanceLevel;
  name: string;
  clientCode?: boolean;
}) {
  const t = useTranslations("applyAppearance");
  const { preview, previewing, dialog } = useApplyAppearance(level, name, clientCode);
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
