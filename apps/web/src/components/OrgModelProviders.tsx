"use client";

import {
  Button,
  Callout,
  FormSection,
  ItemList,
  type ItemListRow,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { capabilitiesIn } from "../lib/extension-capabilities";
import { capabilityGroups, type OrgExtension } from "../lib/extensions";
import { readinessQuery } from "../lib/query/shell";
import { useCapabilityLabel } from "./ExtensionTabs";
import { OrgExtensionSheet } from "./OrgExtensionSheet";
import { useOrgExtensionActions } from "./useOrgExtensionActions";

/** The org's extensions that provide models (the 模型 tab of the 扩展 page). */
export const modelProvidersOf = (extensions: readonly OrgExtension[]): OrgExtension[] =>
  extensions.filter((e) => capabilitiesIn(capabilityGroups(e), "model").length > 0);

/**
 * The org admin's one place to set up a model service (`/settings/models`, the setup checklist's
 * model step while the org has none on): every model service the platform offers this org as a
 * row (its icon, name, state as the 扩展 page derives it) with 启用 while it is off and the org may
 * switch it on, and 配置 where it has org config or overridable platform fields, which opens the
 * extension's Sheet (the one org config form, 保存并启用 while it is off). The actions are the 扩展
 * page's ({@link useOrgExtensionActions}). While the platform has providers but none is on here
 * (readiness `not_enabled`) a warn line above the section says to turn one on. Turning a service on
 * invalidates the org's readiness, models and purposes, so the setup frame, the checklist and the
 * catalog below follow. Switching a service off stays on the 扩展 page.
 */
export function OrgModelProviders({
  orgId,
  superAdmin,
  providers,
  open,
  onOpen,
}: {
  orgId: string;
  /** The viewer is a super admin: an unavailable service's Sheet links to the admin console. */
  superAdmin: boolean;
  /** The org's model services ({@link modelProvidersOf}); at least one. */
  providers: OrgExtension[];
  /** The service whose Sheet is open. */
  open: string | null;
  onOpen(plugin: string | null): void;
}) {
  const t = useTranslations("models.org.providers");
  const capabilityLabel = useCapabilityLabel();
  const notEnabled = useQuery(readinessQuery(orgId)).data?.modelProvider === "not_enabled";
  const actions = useOrgExtensionActions({
    orgId,
    canEdit: true,
    extensions: providers,
    onOpen,
  });

  const listRows: ItemListRow[] = actions.rows.map((r) => {
    const canEnable = !r.ext.enabled && !r.locked;
    const canConfigure = r.configForm || r.overrides;
    const pending = actions.busy[r.ext.plugin] !== undefined;
    return {
      id: r.ext.plugin,
      mark: { text: r.label, image: r.ext.icon ?? null },
      title: r.label,
      meta: [r.ext.displayName ? r.ext.plugin : null, versionLabel(r.ext.version)]
        .filter((x): x is string => x !== null)
        .join(" · "),
      status: {
        label: r.state.label,
        ...(r.state.tone === "warn" || r.state.tone === "fail" ? { tone: "accent" as const } : {}),
      },
      ...(canEnable || canConfigure
        ? {
            actions: (
              <>
                {canConfigure && (
                  <Button
                    density="dense"
                    disabled={pending}
                    aria-label={t("configureLabel", { plugin: r.label })}
                    onClick={() => onOpen(r.ext.plugin)}
                  >
                    {t("configure")}
                  </Button>
                )}
                {canEnable && (
                  <Button
                    density="dense"
                    variant="secondary"
                    loading={actions.busy[r.ext.plugin] === "toggle"}
                    disabled={pending}
                    aria-label={t("enableLabel", { plugin: r.label })}
                    onClick={() => void actions.toggle(r, true)}
                  >
                    {t("enable")}
                  </Button>
                )}
              </>
            ),
          }
        : {}),
    };
  });

  const current = open === null ? undefined : actions.rows.find((r) => r.ext.plugin === open);
  return (
    <>
      {notEnabled && <Callout tone="warn">{t("notEnabled")}</Callout>}
      <FormSection id="providers" title={t("title")} description={t("description")} flush>
        <ItemList label={t("title")} inset="flush" rows={listRows} />
      </FormSection>
      {current !== undefined && (
        <OrgExtensionSheet
          key={current.ext.plugin}
          orgId={orgId}
          canEdit
          superAdmin={superAdmin}
          capabilities={capabilitiesIn(capabilityGroups(current.ext), "all").map(capabilityLabel)}
          onClose={() => onOpen(null)}
          {...actions.sheetProps(current)}
        />
      )}
      {actions.switchOffDialog}
    </>
  );
}
