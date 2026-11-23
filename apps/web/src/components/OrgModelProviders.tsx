"use client";

import {
  Button,
  Callout,
  FormSection,
  ItemList,
  type ItemListRow,
  Switch,
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

/** The org's extensions that provide models (the Models tab of the Extensions page). */
export const modelProvidersOf = (extensions: readonly OrgExtension[]): OrgExtension[] =>
  extensions.filter((e) => capabilitiesIn(capabilityGroups(e), "model").length > 0);

/**
 * The org admin's one place to set up a model service (`/settings/models`, the setup checklist's
 * model step while the org has none on): every model service the platform offers this org as a
 * row (its icon, name, state as the Extensions page derives it) with the Extensions page's on / off
 * switch where the org may use it (none on a locked row: platform, not switchable, unavailable, or
 * waiting for config while off; a scope-`all` service keeps its "on by platform default" state and
 * the switch, since the org may opt out), and Configure where it has org config or overridable platform fields,
 * which opens the extension's Sheet (the one org config form, "Save and enable" while it is off).
 * The actions are the Extensions page's ({@link useOrgExtensionActions}). While no provider is
 * ready here but the org can make one so (readiness `org_fixable`: one is off, or waits for the
 * org's config) a warn line above the section says to turn one on or finish its configuration. Turning a service on
 * invalidates the org's readiness, models and purposes, so the setup frame, the checklist and the
 * catalog below follow. Switching one off asks the Extensions page's switch-off confirmation.
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
  const fixable = useQuery(readinessQuery(orgId)).data?.modelProvider === "org_fixable";
  const actions = useOrgExtensionActions({
    orgId,
    canEdit: true,
    extensions: providers,
    onOpen,
  });

  const listRows: ItemListRow[] = actions.rows.map((r) => {
    const canSwitch = !r.locked;
    const canConfigure = r.overrides;
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
      ...(canSwitch || canConfigure
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
                {canSwitch && (
                  <Switch
                    label={t("enableLabel", { plugin: r.label })}
                    checked={r.ext.enabled}
                    disabled={pending}
                    onChange={(on) => void actions.toggle(r, on)}
                  />
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
      {fixable && <Callout tone="warn">{t("orgFixable")}</Callout>}
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
