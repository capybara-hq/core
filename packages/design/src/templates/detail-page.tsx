import type { ReactNode } from "react";
import type { TabsProps } from "../display/index";
import { Body, type PageHeaderProps, PageTabs } from "../shell/index";
import { TemplateHead, WithStats } from "./frame";

/** T3 详情：PageTabs + Content + Inspector。 */
export function DetailPage({
  header,
  tabs,
  inspector,
  inspectorTitle,
  onInspectorClose,
  children,
}: {
  header: PageHeaderProps;
  tabs: TabsProps;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="cb-template" data-template="DetailPage" data-width="full">
      <TemplateHead header={header} width="full" />
      <PageTabs {...tabs} />
      <Body
        layout={inspector != null ? "inspector" : "single"}
        contentPadded
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        <WithStats header={header}>{children}</WithStats>
      </Body>
    </div>
  );
}
