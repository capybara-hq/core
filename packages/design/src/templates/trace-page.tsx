import type { ReactNode } from "react";
import { Body, PageHeader, type PageHeaderProps } from "../shell/index.js";

/** T8 链路查看器：Single，上为 Span 瀑布，下为 Span 详情。 */
export function TracePage({
  header,
  waterfall,
  detail,
}: {
  header: PageHeaderProps;
  waterfall: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="TracePage">
      <PageHeader {...header} />
      <Body layout="single">
        <div className="cb-trace">
          <div className="cb-trace-waterfall">{waterfall}</div>
          <div className="cb-trace-detail">{detail}</div>
        </div>
      </Body>
    </div>
  );
}
