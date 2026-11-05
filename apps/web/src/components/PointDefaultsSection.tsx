"use client";

import { Field, FormSection, Select, Stack, Text, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type ExtensionPointDefault, putExtensionPointDefault } from "../lib/extensions";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { extensionPointDefaultsQuery } from "../lib/query/settings";
import { useErrorMessage } from "../lib/use-error-message";

/** Message keys of the points the web names (others show the point name). */
const POINT_NAMES: Record<string, "webSearch" | "webFetch"> = {
  "web-search": "webSearch",
  "web-fetch": "webFetch",
};

/**
 * The org's default providers (web tools spec §6) on the org extensions page: one select per
 * `org-default` extension point that two or more enabled, configured extensions provide; every
 * change is saved at once (PUT). While none is chosen the select shows "Not selected" with a
 * hint that the tools using the point are unavailable; a stored default that is not a candidate
 * now (disabled, unconfigured) stays listed as unavailable. Hidden when no point has two
 * candidates or the list cannot be read.
 * From the query cache (a section of the page's prefetch: hidden while it loads); a change
 * invalidates the points and their availability (the agent page's Tools section). Enabling,
 * disabling or configuring an extension invalidates them too (`orgExtensionChangeKeys`).
 */
export function PointDefaultsSection({ orgId }: { orgId: string }) {
  const t = useTranslations("extensions.pointDefaults");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = extensionPointDefaultsQuery(orgId);
  const points = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.points ?? null;
  const put = useAppMutation({
    fn: (v: { point: string; extension: string }) =>
      putExtensionPointDefault(orgId, v.point, v.extension),
    invalidates: () => [
      keys.org(orgId).extensionPointDefaults(),
      keys.org(orgId).extensionPointsAvailable(),
    ],
  });
  const [busy, setBusy] = useState<string>();

  if (points === null) return null;
  const shown = points.filter((p) => p.candidates.length >= 2);
  if (shown.length === 0) return null;

  const nameOf = (point: string) => {
    const key = POINT_NAMES[point];
    return key ? t(`points.${key}`) : point;
  };

  async function choose(p: ExtensionPointDefault, extension: string) {
    if (extension === "" || extension === p.default) return;
    setBusy(p.point);
    try {
      await put.mutateAsync({ point: p.point, extension });
      toast.success(t("saved", { point: nameOf(p.point), extension }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <FormSection id="extension-point-defaults" title={t("title")} description={t("description")}>
      {shown.map((p) => {
        const name = nameOf(p.point);
        const selected = p.effective ?? p.default ?? "";
        const options = [
          ...(selected === "" ? [{ value: "", label: t("none") }] : []),
          ...p.candidates.map((c) => ({ value: c, label: c })),
          // the stored default is kept while it is not a candidate (spec §6): list it as such
          ...(p.default !== null && !p.candidates.includes(p.default)
            ? [{ value: p.default, label: t("unavailable", { extension: p.default }) }]
            : []),
        ];
        return (
          <Stack key={p.point} gap={4}>
            <Field label={name}>
              <Select
                value={selected}
                disabled={busy !== undefined}
                onChange={(e) => void choose(p, e.target.value)}
                options={options}
              />
            </Field>
            {p.effective === null && (
              <Text variant="small" tone="muted">
                {t("noneHint", { point: name })}
              </Text>
            )}
          </Stack>
        );
      })}
    </FormSection>
  );
}
