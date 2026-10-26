import type { ReactNode } from "react";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

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
    <div className="cb-template" data-template="TracePage" data-width="full">
      <TemplateHead header={header} width="full" />
      <Body layout="single">
        <div className="cb-trace">
          <div className="cb-trace-waterfall">{waterfall}</div>
          <div className="cb-trace-detail">{detail}</div>
        </div>
      </Body>
    </div>
  );
}
