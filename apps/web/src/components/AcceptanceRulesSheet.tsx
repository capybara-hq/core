"use client";

import {
  Callout,
  EmptyState,
  RadioGroup,
  Sheet,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type AcceptanceMode, type AcceptanceRules, putAcceptanceRules } from "../lib/automations";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { acceptanceRulesQuery } from "../lib/query/automations";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

const MODES = ["auto", "confirm", "off"] as const;
/** The radio value for "follow the organization's default". */
const DEFAULT = "default";

/** My acceptance rules (the `/automations` route prefetches them on a first load). */
export function useAcceptanceRules(orgId: string) {
  const q = acceptanceRulesQuery(orgId);
  return useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
}

/**
 * The acceptance rules sheet of `/automations` (`?rules=1`; collaboration spec §4.4): one choice
 * per source that directs events to me and my agent: follow the organization's default, run at
 * once (my acceptance automation for that source and agent), ask me first (an offer in my inbox),
 * or never. A choice is saved at once (`PUT` sends that source's rule).
 */
export function AcceptanceRulesSheet({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useTranslations("acceptance");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const locale = labelLocale(useLocale());
  const qc = useQueryClient();
  const q = acceptanceRulesQuery(orgId);
  const read = useAcceptanceRules(orgId);
  const save = useAppMutation({
    fn: (v: { source: string; mode: AcceptanceMode | null }) => putAcceptanceRules(orgId, [v]),
    invalidates: () => [],
    onSuccess: (res) => qc.setQueryData<AcceptanceRules>(q.queryKey, res),
  });
  async function choose(source: string, value: string) {
    try {
      await save.mutateAsync({
        source,
        mode: value === DEFAULT ? null : (value as AcceptanceMode),
      });
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("title")} width={480}>
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("description")}
        </Text>
        {read.isPending ? (
          <Skeleton rows={4} />
        ) : read.isError ? (
          <Callout tone="fail" action={{ label: tc("retry"), onSelect: () => void read.refetch() }}>
            {errorMessage(read.error)}
          </Callout>
        ) : read.data.items.length === 0 ? (
          <EmptyState size="panel" text={t("empty")} />
        ) : (
          read.data.items.map((r) => {
            const name = extensionLabel({ name: r.source, displayName: r.name }, locale);
            return (
              <RadioGroup
                key={r.source}
                label={name}
                disabled={save.isPending}
                value={r.mode ?? DEFAULT}
                onChange={(v) => void choose(r.source, v)}
                options={[
                  {
                    value: DEFAULT,
                    label: t("mode.default", { mode: t(`mode.${read.data.directedDefault}`) }),
                    description: t("mode.defaultHint"),
                  },
                  ...MODES.map((m) => ({
                    value: m,
                    label: t(`mode.${m}`),
                    description: t(`mode.${m}Hint`, { source: name }),
                  })),
                ]}
              />
            );
          })
        )}
      </Stack>
    </Sheet>
  );
}
