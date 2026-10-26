"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CatalogInstallWizard } from "../../../../../components/CatalogInstallWizard";
import { useConnectorWizard } from "../../../../../components/ConnectorWizard";
import { OrgGate } from "../../../../../components/OrgGate";

/** `?template=<目录条目 id>`：挂载后在 effect 里读（客户端跳转时渲染那一刻地址栏可能还没更新）。 */
const templateParam = (): string | null => {
  const v = new URLSearchParams(window.location.search).get("template");
  return v === null || v === "" ? null : v;
};

/**
 * `/[locale]/connectors/install`: the install-connector wizard (WizardPage): endpoint type ->
 * endpoint and docs -> auth -> tools and default policies -> done.
 * `?template=<catalog item id>`: prefilled from a connector template in the catalog (the template
 * decides the endpoint; only the fields the template allows and the credentials can change),
 * installed through the catalog (subject to the item's policy), the same wizard as
 * `/catalog/<id>/install`.
 * The wizard belongs to the org it was opened in: switching orgs starts over (rebuilt with orgId as
 * the key).
 */
export default function InstallAppPage() {
  return <OrgGate>{(orgId) => <Install key={orgId} orgId={orgId} />}</OrgGate>;
}

function Install({ orgId }: { orgId: string }) {
  // undefined：还没读查询串
  const [template, setTemplate] = useState<string | null | undefined>(undefined);
  useEffect(() => setTemplate(templateParam()), []);
  if (template === undefined) return null;
  return template !== null ? (
    <CatalogInstallWizard
      orgId={orgId}
      itemId={template}
      frame={(v) => (
        <WizardPage header={v.header} steps={v.steps} current={v.current} actionRow={v.actionRow}>
          {v.body}
        </WizardPage>
      )}
    />
  ) : (
    <InstallApp orgId={orgId} />
  );
}

function InstallApp({ orgId }: { orgId: string }) {
  const t = useTranslations("connectors");
  const wizard = useConnectorWizard(orgId);
  return (
    <WizardPage
      header={{
        breadcrumb: [{ label: t("title"), href: "/connectors" }],
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
