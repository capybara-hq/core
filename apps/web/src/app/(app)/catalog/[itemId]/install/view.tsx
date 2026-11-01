"use client";

import { WizardPage } from "@capybara-hq/design";
import {
  type CatalogInstallData,
  CatalogInstallWizard,
} from "../../../../../components/CatalogInstallWizard";

/**
 * `/catalog/[itemId]/install`: install a connector template or a plugin from the catalog
 * (WizardPage; see CatalogInstallWizard), from the item the server read (`page.tsx`).
 */
export default function CatalogInstallView({
  orgId,
  itemId,
  initial,
}: {
  orgId: string;
  itemId: string;
  initial: CatalogInstallData;
}) {
  return (
    <CatalogInstallWizard
      orgId={orgId}
      itemId={itemId}
      initial={initial}
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
  );
}
