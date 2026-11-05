"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  CatalogInstallWizard,
  useCatalogInstall,
  type WizardView,
} from "../../../../components/CatalogInstallWizard";
import { useConnectorWizard, WIZARD_STEPS } from "../../../../components/ConnectorWizard";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { type ConnectorKind, wizardKinds } from "../../../../lib/connectors";
import { connectorKindsQuery } from "../../../../lib/query/conversation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/connectors/install`: the install-connector wizard (WizardPage): endpoint type ->
 * endpoint and docs -> auth -> tools and default policies -> done. The type step offers only the
 * connector kinds whose extension is enabled in the org (from the query cache; with none it points
 * to Plugins).
 * `?template=<catalog item id>`: prefilled from a connector template in the catalog (the template
 * decides the endpoint; only the fields the template allows and the credentials can change),
 * installed through the catalog (the plugin's switch), the same wizard as
 * `/plugins/<id>/enable`. The template's item comes from the query cache (the layout prefetched it
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
  const read = usePageQuery(connectorKindsQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const header = {
    path: [...scope, { label: "connectors", href: "/connectors" }, { label: "install" }],
    title: t("wizard.title"),
  };
  if (read.kind === "loading") {
    return (
      <WizardPage
        header={header}
        steps={WIZARD_STEPS.map((s) => t(`wizard.steps.${s}`))}
        current={0}
        actionRow={{ primary: { label: t("wizard.next"), onSelect: () => {} } }}
        loading={{ fields: 1 }}
      />
    );
  }
  return <InstallWizard orgId={orgId} header={header} kinds={wizardKinds(read.data.kinds)} />;
}

function InstallWizard({
  orgId,
  header,
  kinds,
}: {
  orgId: string;
  header: { path: { label: string; href?: string }[]; title: string };
  kinds: ConnectorKind[];
}) {
  const wizard = useConnectorWizard(orgId, kinds);
  return (
    <WizardPage
      header={header}
      steps={wizard.steps}
      current={wizard.current}
      actionRow={wizard.actionRow}
    >
      {wizard.body}
    </WizardPage>
  );
}
