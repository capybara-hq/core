"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useConnectorWizard } from "../../../../../components/ConnectorWizard";
import { OrgGate } from "../../../../../components/OrgGate";

/**
 * `/[locale]/connectors/install`：安装连接器向导（WizardPage）：端点类型 → 端点与文档 → 认证 → 工具与默认策略 → 完成。
 * 向导属于打开它时的组织：切换组织后从头开始（以 orgId 为 key 重建）。
 */
export default function InstallAppPage() {
  return <OrgGate>{(orgId) => <InstallApp key={orgId} orgId={orgId} />}</OrgGate>;
}

function InstallApp({ orgId }: { orgId: string }) {
  const t = useTranslations("connectors");
  const wizard = useConnectorWizard(orgId);
  return (
    <WizardPage
      header={{ parent: { label: t("title"), href: "/connectors" }, title: t("wizard.title") }}
      steps={wizard.steps}
      current={wizard.current}
      actionRow={wizard.actionRow}
    >
      {wizard.body}
    </WizardPage>
  );
}
