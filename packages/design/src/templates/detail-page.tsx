import type { ReactNode } from "react";
import type { TabsProps } from "../display/index";
import { Body, PageHeader, type PageHeaderProps, PageTabs } from "../shell/index";

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
    <div className="cb-template" data-template="DetailPage">
      <PageHeader {...header} />
      <PageTabs {...tabs} />
      <Body
        layout={inspector != null ? "inspector" : "single"}
        contentPadded
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        {children}
      </Body>
    </div>
  );
}
