"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  CatalogInstallWizard,
  useCatalogInstall,
  type WizardView,
} from "../../../../components/CatalogInstallWizard";
import { useConnectorWizard } from "../../../../components/ConnectorWizard";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/connectors/install`: the install-connector wizard (WizardPage): endpoint type ->
 * endpoint and docs -> auth -> tools and default policies -> done.
 * `?template=<catalog item id>`: prefilled from a connector template in the catalog (the template
 * decides the endpoint; only the fields the template allows and the credentials can change),
 * installed through the catalog (subject to the item's policy), the same wizard as
 * `/catalog/<id>/install`. The template's item comes from the query cache (the layout prefetched it
 * on a first load); a missing one is the not-found state.
 */
export default function InstallConnectorView({ template }: { template: string | null }) {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return template !== null ? (
    <InstallTemplate key={template} orgId={ws.orgId} itemId={template} />
  ) : (
    <InstallApp orgId={ws.orgId} />
  );
}

function InstallTemplate({ orgId, itemId }: { orgId: string; itemId: string }) {
  const read = useCatalogInstall(orgId, itemId);
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <CatalogInstallWizard
      orgId={orgId}
      itemId={itemId}
      data={read.kind === "ready" ? read.data : null}
      frame={(v: WizardView) => (
        <WizardPage
          header={{ path: v.path, title: v.title }}
          steps={v.steps}
          current={v.current}
          actionRow={v.actionRow}
          {...(v.wizardLoading ? { loading: v.wizardLoading } : {})}
        >
          {v.body}
        </WizardPage>
      )}
    />
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
