"use client";

import { WizardPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useConnectorWizard } from "../../../../../components/ConnectorWizard";
import { DirectoryInstallWizard } from "../../../../../components/DirectoryInstallWizard";
import { OrgGate } from "../../../../../components/OrgGate";

/** `?template=<目录条目 id>`：挂载后在 effect 里读（客户端跳转时渲染那一刻地址栏可能还没更新）。 */
const templateParam = (): string | null => {
  const v = new URLSearchParams(window.location.search).get("template");
  return v === null || v === "" ? null : v;
};

/**
 * `/[locale]/connectors/install`：安装连接器向导（WizardPage）：端点类型 → 端点与文档 → 认证 → 工具与默认策略 → 完成。
 * `?template=<目录条目 id>`：按企业目录里的连接器模板预填（端点以模板为准，只能改模板允许的字段与凭据），
 * 走目录安装（受条目策略约束），与 `/directory/<id>/install` 同一个向导。
 * 向导属于打开它时的组织：切换组织后从头开始（以 orgId 为 key 重建）。
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
    <DirectoryInstallWizard
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
      header={{ parent: { label: t("title"), href: "/connectors" }, title: t("wizard.title") }}
      steps={wizard.steps}
      current={wizard.current}
      actionRow={wizard.actionRow}
    >
      {wizard.body}
    </WizardPage>
  );
}
