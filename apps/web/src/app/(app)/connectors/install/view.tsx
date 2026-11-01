"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  type CatalogInstallData,
  CatalogInstallWizard,
} from "../../../../components/CatalogInstallWizard";
import { useConnectorWizard } from "../../../../components/ConnectorWizard";
import { usePagePath } from "../../../../components/shell/path";

/**
 * `/connectors/install`: the install-connector wizard (WizardPage): endpoint type ->
 * endpoint and docs -> auth -> tools and default policies -> done.
 * `?template=<catalog item id>`: prefilled from a connector template in the catalog (the template
 * decides the endpoint; only the fields the template allows and the credentials can change),
 * installed through the catalog (subject to the item's policy), the same wizard as
 * `/catalog/<id>/install`.
 * The template's item is read on the server (`page.tsx`, `template` with it).
 */
export default function InstallConnectorView({
  orgId,
  template,
}: {
  orgId: string;
  template: { itemId: string; initial: CatalogInstallData } | null;
}) {
  return template !== null ? (
    <CatalogInstallWizard
      orgId={orgId}
      itemId={template.itemId}
      initial={template.initial}
      frame={(v) => (
        <WizardPage
          header={{ path: v.path, title: v.title }}
          steps={v.steps}
          current={v.current}
          actionRow={v.actionRow}
        >
          {v.body}
        </WizardPage>
      )}
    />
  ) : (
    <InstallApp orgId={orgId} />
  );
}

function InstallApp({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const wizard = useConnectorWizard(orgId);
  return (
    <WizardPage
      header={{
        path: [...scope, { label: "connectors", href: "/connectors" }, { label: "install" }],
        title: t("wizard.title"),
      }}
      steps={wizard.steps}
      current={wizard.current}
      actionRow={wizard.actionRow}
    >
      {wizard.body}
    </WizardPage>
  );
}
