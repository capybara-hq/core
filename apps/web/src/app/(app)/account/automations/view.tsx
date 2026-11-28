"use client";

import { FormSection, RadioGroup, SettingsPage, Stack, Text, useToast } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AcceptanceMode,
  type AcceptanceRules,
  putAcceptanceRules,
} from "../../../../lib/automations";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import { acceptanceRulesQuery } from "../../../../lib/query/automations";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";

const MODES = ["auto", "confirm", "off"] as const;
/** The radio value for "follow the organization's default". */
const DEFAULT = "default";

/**
 * `/account/automations` (SettingsPage; members up, in the current org): Accepting work
 * (collaboration spec §4.4). One choice per source that assigns work to me and my agent: follow
 * the organization's default, run it at once (my acceptance automation for that source and agent),
 * ask me first (a work offer in my inbox), or never. A choice is saved at once (`PUT` sends that
 * source's rule). From the query cache (the layout prefetched my rules on a first load).
 */
export default function AccountAutomationsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <AccountAutomations orgId={ws.orgId} />;
}

function AccountAutomations({ orgId }: { orgId: string }) {
  const t = useTranslations("acceptance");
  const scope = usePagePath("home");
  const nav = useAccountNav();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const locale = labelLocale(useLocale());
  const qc = useQueryClient();
  const q = acceptanceRulesQuery(orgId);
  const read = usePageQuery(q);
  const save = useAppMutation({
    fn: (v: { source: string; mode: AcceptanceMode | null }) => putAcceptanceRules(orgId, [v]),
    invalidates: () => [],
    onSuccess: (res) => qc.setQueryData<AcceptanceRules>(q.queryKey, res),
  });
  const header = {
    path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "automations" }],
    title: t("title"),
    description: t("description"),
  };
  if (read.kind === "notFound" || read.kind === "error") {
    return (
      <SettingsPage header={header} nav={nav} activeNav="automations">
        <ErrorFrame reset={read.kind === "error" ? read.retry : () => location.reload()} />
      </SettingsPage>
    );
  }
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="automations"
        loading={{
          sections: [
            {
              fields: [{ control: "radio-cards", options: 4 }],
              title: t("section"),
              description: t("sectionHint"),
            },
          ],
        }}
      />
    );
  }
  const { items, directedDefault } = read.data;
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
    <SettingsPage header={header} nav={nav} activeNav="automations">
      <FormSection id="acceptance-sources" title={t("section")} description={t("sectionHint")}>
        {items.length === 0 ? (
          <Text tone="muted">{t("empty")}</Text>
        ) : (
          <Stack gap={16}>
            {items.map((r) => {
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
                      label: t("mode.default", { mode: t(`mode.${directedDefault}`) }),
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
            })}
          </Stack>
        )}
      </FormSection>
    </SettingsPage>
  );
}
