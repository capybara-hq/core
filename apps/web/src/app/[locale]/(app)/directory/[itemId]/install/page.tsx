"use client";

import { WizardPage } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { DirectoryInstallWizard } from "../../../../../../components/DirectoryInstallWizard";
import { OrgGate } from "../../../../../../components/OrgGate";

/**
 * `/[locale]/directory/[itemId]/install`：从目录安装连接器模板或应用（WizardPage，组织管理员；见 DirectoryInstallWizard）。
 * 向导属于打开它时的组织：切换组织后从头开始（以 orgId 为 key 重建）。
 */
export default function DirectoryInstallPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return (
    <OrgGate>
      {(orgId) => (
        <DirectoryInstallWizard
          key={orgId}
          orgId={orgId}
          itemId={itemId}
          frame={(v) => (
            <WizardPage
              header={v.header}
              steps={v.steps}
              current={v.current}
              actionRow={v.actionRow}
            >
              {v.body}
            </WizardPage>
          )}
        />
      )}
    </OrgGate>
  );
}
