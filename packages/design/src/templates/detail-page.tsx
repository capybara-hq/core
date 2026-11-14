import type { ReactNode } from "react";
import { SkeletonBox, SkeletonGroup, Tabs, type TabsProps } from "../display/index";
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
    /**
     * The band form (`header.titleHidden`): the page's first block is its name band, a band-shaped
     * skeleton of the loaded band's height in its place, so the head never jumps.
     */
    band?: boolean;
    blocks?: number;
    content?: BlockShape[];
    /** Stat card placeholders for the header's metrics, which come with the data. */
    stats?: number;
  };
  children?: ReactNode;
}) {
  const t = useDesignT();
  // The band form (spec §4.2, §5.2): the page's first block is its own name band, so the band is
  // the head's last row and the tab row follows it — the template head carries no tabs then.
  const band = header.titleHidden === true;
  const shape = loading?.facts;
  const factsNode = loading?.band ? (
    <div className="cb-detail-band-skeleton" data-part="detail-band-skeleton" aria-hidden="true">
      <div className="cb-detail-band-skeleton-main">
        <SkeletonBox part="block" width={180} height={20} />
        <SkeletonBox part="block" width={150} height={14} />
      </div>
      <div className="cb-detail-band-skeleton-figures">
        <SkeletonBox part="block" width={70} height={14} />
        <SkeletonBox part="block" width={90} height={14} />
        <SkeletonBox part="block" width={90} height={14} />
      </div>
    </div>
  ) : shape ? (
    <LoadingFacts {...(typeof shape === "object" ? shape : {})} />
  ) : (
    facts
  );
  const content = loading ? (
    loading.content ? (
      <LoadingBlocks blocks={loading.content} />
    ) : (
      <LoadingCards count={loading.blocks ?? LOADING_BLOCKS} />
    )
  ) : (
    children
  );
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
          {...(band ? { band: true } : tabs !== undefined ? { tabs } : {})}
        />
      }
    >
      {band ? (
        <div className="cb-detail-band" data-tabs={tabs !== undefined ? "true" : undefined}>
          {factsNode != null && factsNode !== false ? (
            <div className="cb-detail-band-facts" data-part="detail-facts">
              {factsNode}
            </div>
          ) : null}
          {tabs !== undefined ? (
            <div className="cb-pageheader-tabs cb-detail-band-tabs" data-part="page-tabs">
              <Tabs {...tabs} />
            </div>
          ) : null}
          <div className="cb-detail-band-content">{content}</div>
        </div>
      ) : (
        <>
          {factsNode != null && factsNode !== false ? (
            <div data-part="detail-facts">{factsNode}</div>
          ) : null}
          {content}
        </>
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
