"use client";

import { FormSection, Icon, IconButton, Stack, Switch, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  getOrgFilePreviewers,
  type OrgFilePreviewer,
  putOrgFilePreviewers,
  reorder,
} from "../lib/previewers";
import { uiLocale } from "../lib/ui";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";

/**
 * The org's file previewers (`file-preview@1`, UI refresh B Task 11) on the org extensions page:
 * one row per previewer of an enabled extension, in the org's order, with up / down and an enable
 * switch; every change is saved at once (PUT). Hidden when no enabled extension provides one or the
 * list cannot be read.
 */
export function FilePreviewersSection({ orgId }: { orgId: string }) {
  const t = useTranslations("filePreviewers");
  const locale = uiLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { state, set } = useLoad(() => getOrgFilePreviewers(orgId).then((r) => r.items), [orgId]);
  const [busy, setBusy] = useState(false);
  if (state.kind !== "ready" || state.data.length === 0) return null;
  const items = state.data;

  async function save(next: { plugin: string; id: string; disabled: boolean }[]) {
    setBusy(true);
    try {
      set((await putOrgFilePreviewers(orgId, next)).items);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const body = (list: OrgFilePreviewer[]) =>
    list.map((p) => ({ plugin: p.plugin, id: p.id, disabled: p.disabled }));

  return (
    <FormSection id="file-previewers" title={t("title")} description={t("description")}>
      {items.map((p, i) => {
        const name = p.title[locale];
        return (
          <Stack key={`${p.plugin}/${p.id}`} direction="row" gap={8} align="center">
            <Switch
              label={t("enableLabel", { name })}
              checked={!p.disabled}
              disabled={busy}
              onChange={(on) =>
                void save(body(items.map((x, j) => (j === i ? { ...x, disabled: !on } : x))))
              }
            />
            <Stack gap={0}>
              <Text>{name}</Text>
              <Text variant="small" tone="muted">
                {t("source", { plugin: p.plugin })}
              </Text>
            </Stack>
            <IconButton
              label={t("moveUp", { name })}
              icon={<Icon name="arrow-up" size={14} />}
              disabled={busy || i === 0}
              onClick={() => void save(reorder(items, i, -1))}
            />
            <IconButton
              label={t("moveDown", { name })}
              icon={<Icon name="arrow-down" size={14} />}
              disabled={busy || i === items.length - 1}
              onClick={() => void save(reorder(items, i, 1))}
            />
          </Stack>
        );
      })}
    </FormSection>
  );
}
