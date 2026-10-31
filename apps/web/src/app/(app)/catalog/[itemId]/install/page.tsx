"use client";

import { WizardPage } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { CatalogInstallWizard } from "../../../../../components/CatalogInstallWizard";
import { RoleGate } from "../../../../../components/RoleGate";

/**
 * `/catalog/[itemId]/install`: install a connector template or a plugin from the catalog
 * (WizardPage, org admins; see CatalogInstallWizard). The wizard belongs to the org it was opened in:
 * switching orgs starts over (rebuilt with orgId as the key).
 */
export default function CatalogInstallPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return (
    <RoleGate min="admin">
      {(orgId) => (
        <CatalogInstallWizard
          key={orgId}
          orgId={orgId}
          itemId={itemId}
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
      )}
    </RoleGate>
  );
}
