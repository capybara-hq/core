"use client";

import { Button, Callout, FormSection, ItemList, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useRef } from "react";
import { clientError } from "../lib/api";
import {
  clearPlatformIcon,
  DEFAULT_PLATFORM_ICONS,
  fileBase64,
  PLATFORM_ICON_MAX_BYTES,
  PLATFORM_ICON_PURPOSES,
  PLATFORM_ICON_TYPE,
  type PlatformIconPurpose,
  setPlatformIcon,
} from "../lib/platform-icons";
import { platformIconsQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * What an icon write changes: the settings' list, the public meta (the manifest and the page icons
 * read it) and the platform audit log.
 */
const iconKeys = (): (readonly unknown[])[] => [
  keys.deployment().platformIcons(),
  keys.deployment().platformMeta(),
  keys.deployment().platformAuditAll(),
];

/** A row placeholder: the title and meta lines, the upload button. */
const ROW = { lines: 2, buttons: 1 } as const;

/**
 * 应用图标 (mobile layout spec §10.2.1): the installed app's icon for the whole deployment, on the
 * super admin's `/admin/settings` (the page is the super admin's alone, so nobody else sees it). A
 * row per purpose (the app icon, its maskable variant, the SVG favicon) with its current picture
 * (the upload, else the web's default), 上传 (the file goes as base64 JSON; the kernel checks the
 * type and the PNG's 512 × 512) and, for an upload, 恢复默认. Each action saves at once, apart from
 * the page's ActionRow.
 */
export function AppIconSection() {
  const t = useTranslations("appIcon");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const iq = platformIconsQuery();
  const read = useQuery({ ...iq, retryOnMount: retryOnMountOf(iq.queryKey) });
  const inputs = useRef<Partial<Record<PlatformIconPurpose, HTMLInputElement | null>>>({});
  const upload = useAppMutation({
    fn: async ({ purpose, file }: { purpose: PlatformIconPurpose; file: File }) => {
      if (file.size > PLATFORM_ICON_MAX_BYTES) throw clientError("platform_icon.too_large");
      return setPlatformIcon(purpose, await fileBase64(file));
    },
    invalidates: iconKeys,
    onSuccess: () => toast.success(t("uploaded")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useAppMutation({
    fn: (purpose: PlatformIconPurpose) => clearPlatformIcon(purpose),
    invalidates: iconKeys,
    onSuccess: () => toast.success(t("restored")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const busy = upload.isPending || restore.isPending;
  const uploaded = read.data?.icons ?? [];

  const onFile = (purpose: PlatformIconPurpose) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file !== undefined) upload.mutate({ purpose, file });
  };

  const head = { id: "app-icon", title: t("title"), description: t("description") };
  // Never claim 默认 for an icon whose state is unknown: placeholders while reading, the failure
  // with a retry (and no actions) when the read failed.
  if (read.isPending) {
    return <FormSection {...head} loading={{ items: PLATFORM_ICON_PURPOSES.map(() => ROW) }} />;
  }
  if (read.isError) {
    return (
      <FormSection {...head}>
        <Callout tone="fail" action={{ label: tc("retry"), onSelect: () => void read.refetch() }}>
          {errorMessage(read.error)}
        </Callout>
      </FormSection>
    );
  }

  return (
    <FormSection {...head} flush>
      <ItemList
        label={t("title")}
        inset="flush"
        rows={PLATFORM_ICON_PURPOSES.map((purpose) => {
          const icon = uploaded.find((i) => i.purpose === purpose);
          const title = t(`${purpose}.title`);
          return {
            id: purpose,
            mark: { text: title, image: icon?.url ?? DEFAULT_PLATFORM_ICONS[purpose] },
            title,
            meta: `${t(`${purpose}.hint`)} · ${icon !== undefined ? t("custom") : t("default")}`,
            actions: (
              <>
                <Button
                  variant="default"
                  disabled={busy}
                  onClick={() => inputs.current[purpose]?.click()}
                >
                  {t("upload")}
                </Button>
                {icon !== undefined && (
                  <Button variant="ghost" disabled={busy} onClick={() => restore.mutate(purpose)}>
                    {t("restore")}
                  </Button>
                )}
                <input
                  ref={(el) => {
                    inputs.current[purpose] = el;
                  }}
                  type="file"
                  hidden
                  aria-label={t("uploadLabel", { name: title })}
                  accept={PLATFORM_ICON_TYPE[purpose]}
                  onChange={onFile(purpose)}
                />
              </>
            ),
          };
        })}
      />
    </FormSection>
  );
}
