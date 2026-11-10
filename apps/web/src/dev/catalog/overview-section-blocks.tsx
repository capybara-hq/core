import { ItemList, OverviewSection, TextLink } from "@capybara-hq/design";
import { OVERVIEW_SECTION_FIXTURE as F } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// OverviewSection (spec §5.6): one section of an overview page in its three states. The blocks
// have the same ids and boxes as docs/design/reference/src/overview-section.html.

const noop = () => {};
const W = 720;

function Action() {
  return <TextLink href="#inbox">{F.action}</TextLink>;
}

function Rows() {
  return (
    <ItemList
      label={F.title}
      rows={F.rows.map((r) => ({
        id: r.id,
        title: r.title,
        meta: r.meta,
        status: { label: r.count },
      }))}
    />
  );
}

function overviewSectionBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="overview-section-default" width={W} pad>
        <OverviewSection title={F.title} actions={<Action />} state="ready">
          <Rows />
        </OverviewSection>
      </RefBlock>
      <RefBlock id="overview-section-loading" width={W} pad>
        <OverviewSection
          title={F.title}
          actions={<Action />}
          state="loading"
          loading={[{ kind: "list", items: F.loadingItems }]}
        >
          <Rows />
        </OverviewSection>
      </RefBlock>
      <RefBlock id="overview-section-error" width={W} pad>
        <OverviewSection
          title={F.title}
          actions={<Action />}
          state="error"
          error={{ summary: F.errorSummary, detail: F.errorDetail, onRetry: noop }}
        >
          <Rows />
        </OverviewSection>
      </RefBlock>
    </>
  );
}

export const OVERVIEW_SECTION_BLOCKS = {
  "overview-section": overviewSectionBlocks,
} as const;
