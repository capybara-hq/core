"use client";

import { WizardPage } from "@capybara-hq/design";
import {
  CatalogInstallWizard,
  useCatalogInstall,
} from "../../../../../components/CatalogInstallWizard";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { useWorkspace } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

/**
 * `/plugins/[itemId]/enable`: the input a plugin asks for before it is switched on (its connector
 * templates, its extension's org config; WizardPage, see CatalogInstallWizard), opened from 启用 on
 * the 插件 page; the wizard ends with the plugin's switch. From the item and the org's extensions
 * in the query cache (the layout prefetched them on a first load).
 */
export default function PluginEnableView({ itemId }: { itemId: string }) {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Install key={itemId} orgId={ws.orgId} itemId={itemId} />;
}

function Install({ orgId, itemId }: { orgId: string; itemId: string }) {
  const read = useCatalogInstall(orgId, itemId);
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <CatalogInstallWizard
      orgId={orgId}
      itemId={itemId}
      data={read.kind === "ready" ? read.data : null}
      frame={(v) => (
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
