import type { ReactNode } from "react";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index.js";

/** T1 概览：Single。 */
export function OverviewPage({
  header,
  children,
}: {
  header: PageHeaderProps;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="OverviewPage">
      <PageHeader {...header} />
      <Body layout="single">{children}</Body>
    </div>
  );
}
