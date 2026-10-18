"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link } from "../i18n/navigation";
import { useCurrentOrg } from "../lib/use-current-org";

/** 需要当前组织的页面外壳：加载中 / 未选组织 / 出错时显示提示，就绪后渲染 `children(orgId)`。 */
export function OrgGate({ children }: { children: (orgId: string) => ReactNode }) {
  const t = useTranslations();
  const org = useCurrentOrg();
  if (org.kind === "loading") return <p>{t("common.loading")}</p>;
  if (org.kind === "error") {
    return (
      <p role="alert" className="error">
        {org.message}
      </p>
    );
  }
  if (org.kind === "none") {
    return (
      <div className="card">
        <p>{t("agents.noOrg")}</p>
        <Link href="/">{t("agents.backHome")}</Link>
      </div>
    );
  }
  return children(org.orgId);
}
