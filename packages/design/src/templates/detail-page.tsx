import type { ReactNode } from "react";
import { SkeletonGroup, type TabsProps } from "../display/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps } from "../shell/index";
import {
  type BlockShape,
  LoadingBlocks,
  LoadingCards,
  LoadingFacts,
  loadingHeader,
  TemplateHead,
} from "./frame";

/** Content blocks a loading detail page draws when it is not told how many (spec §5.2). */
const LOADING_BLOCKS = 2;

/** What a loading detail page's facts look like: KeyValue placeholders (spec §5.2). */
export type FactsShape = {
  rows?: number;
  keyWidth?: string;
  columns?: 1 | 2;
  /** A `prose` line over the rows (gap 12): the loaded facts start with the description. */
  lead?: boolean;
};

/**
 * T3 Detail: the head's tab row + one centred column (spec §5.2; no right pane). `facts` is the object's facts
 * block (a KeyValue, or the page's grouped KeyValues), drawn first in the column, right under the
 * head, above the tab's content (`children`). `loading` draws the page's frame while its data is on
 * the way: the header keeps its rows (`header.loading`), the tabs stay real (they are static per
 * page), the content is `blocks` card-shaped blocks (default 2) in place of `children`, and the
 * facts block is KeyValue placeholders only when `loading.facts` is set (a real `facts` stays; an
 * object gives its `rows`, `keyWidth`, `columns` and `lead`). A page whose tab has a known static structure
 * passes `content` (`BlockShape[]`) instead of `blocks`: those blocks are drawn in a gap-16 stack,
 * as the loaded tab stacks its parts, so nothing moves when the data lands. `stats` draws that many
 * stat card placeholders under the header for the metrics the page does not know yet (the header's
 * own `metrics` render for real instead).
 */
export function DetailPage({
  header,
  tabs,
  facts,
  loading,
  children,
}: {
  header: PageHeaderProps;
  /** The object's views; left out when it has one view (a tab row of one tab says nothing). */
  tabs?: TabsProps | undefined;
  facts?: ReactNode;
  loading?: {
    facts?: boolean | FactsShape;
    blocks?: number;
    content?: BlockShape[];
    /** Stat card placeholders for the header's metrics, which come with the data. */
    stats?: number;
  };
  children?: ReactNode;
}) {
  const t = useDesignT();
  const shape = loading?.facts;
  const factsNode = shape ? <LoadingFacts {...(typeof shape === "object" ? shape : {})} /> : facts;
  const body = (
    <Body
      layout="single"
      contentPadded
      width="content"
      head={
        <TemplateHead
          header={loading ? loadingHeader(header) : header}
          statsInHead
          loadingStats={loading?.stats ?? 0}
          {...(tabs !== undefined ? { tabs } : {})}
        />
      }
    >
      {factsNode != null && factsNode !== false ? (
        <div data-part="detail-facts">{factsNode}</div>
      ) : null}
      {loading ? (
        loading.content ? (
          <LoadingBlocks blocks={loading.content} />
        ) : (
          <LoadingCards count={loading.blocks ?? LOADING_BLOCKS} />
        )
      ) : (
        children
      )}
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
