import type { ReactNode } from "react";
import { SkeletonGroup, type TabsProps } from "../display/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps, PageTabs } from "../shell/index";
import { LoadingCards, LoadingInspector, loadingHeader, TemplateHead } from "./frame";

/** Content blocks a loading detail page draws when it is not told how many (spec §5.2). */
const LOADING_BLOCKS = 2;

/**
 * T3 详情：PageTabs + Content + Inspector. `loading` draws the page's frame while its data is on
 * the way (spec §5.2): the header keeps its rows (`header.loading`), the tabs stay real (they are
 * static per page), the content is `blocks` card-shaped blocks (default 2) in place of `children`,
 * and the inspector is a skeleton only when `inspector` is set (a real `inspector` stays).
 */
export function DetailPage({
  header,
  tabs,
  inspector,
  inspectorTitle,
  onInspectorClose,
  loading,
  children,
}: {
  header: PageHeaderProps;
  tabs: TabsProps;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  loading?: { inspector?: boolean; blocks?: number };
  children?: ReactNode;
}) {
  const t = useDesignT();
  const inspectorNode = loading?.inspector ? <LoadingInspector /> : inspector;
  const body = (
    <Body
      layout={inspectorNode != null ? "inspector" : "single"}
      contentPadded
      width="content"
      head={
        <TemplateHead header={loading ? loadingHeader(header) : header} statsInHead>
          <PageTabs {...tabs} />
        </TemplateHead>
      }
      inspector={inspectorNode}
      {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
      {...(onInspectorClose ? { onInspectorClose } : {})}
    >
      {loading ? <LoadingCards count={loading.blocks ?? LOADING_BLOCKS} /> : children}
    </Body>
  );
  return (
    <div className="cb-template" data-template="DetailPage" data-width="content">
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{body}</SkeletonGroup>
      ) : (
        body
      )}
    </div>
  );
}
