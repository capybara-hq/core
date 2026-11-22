import { Fragment, type JSX, type ReactNode } from "react";
import { CodeBlock } from "./chat";
import { CheckRow } from "./check-row";
import { Markdown } from "./markdown";

/**
 * A rendered setup guide's block (setup guides v2 spec §7.2). Structurally equal to the SDK's
 * `SetupGuideBlock`; the design package depends on no `@capybara-hq/*`, so it is declared here.
 */
export type GuideBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string; title: string | null; text: string }
  | { kind: "check"; id: string; label: string }
  | { kind: "action"; id: string; label: string };

export type GuideDocumentProps = {
  blocks: GuideBlock[];
  /** Draws a check (a live CheckRow); by default a static CheckRow ("checked after saving"). */
  renderCheck?: (block: { id: string; label: string }) => ReactNode;
  /** Draws an action block (a button the page owns); absent or null: the block draws nothing. */
  renderAction?: (block: { id: string; label: string }) => ReactNode;
};

/**
 * A rendered setup guide (spec §6.9): prose as Markdown, code as a copyable CodeBlock with its
 * title, checks as CheckRows, in document order. It draws no box: it sits in the page's section
 * card, where its code blocks draw their borderless form (§1 "One box is enough").
 */
export function GuideDocument({
  blocks,
  renderCheck,
  renderAction,
}: GuideDocumentProps): JSX.Element {
  return (
    <div className="cb-guide" data-part="guide-document">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one rendered document
        <Fragment key={i}>{drawBlock(block, renderCheck, renderAction)}</Fragment>
      ))}
    </div>
  );
}

function drawBlock(
  block: GuideBlock,
  renderCheck: GuideDocumentProps["renderCheck"],
  renderAction: GuideDocumentProps["renderAction"],
): ReactNode {
  switch (block.kind) {
    case "markdown":
      return <Markdown text={block.text} />;
    case "code":
      return (
        <CodeBlock
          {...(block.language === "" ? {} : { language: block.language })}
          {...(block.title === null ? {} : { title: block.title })}
          text={block.text}
          copyable
        />
      );
    case "check":
      return renderCheck ? (
        renderCheck({ id: block.id, label: block.label })
      ) : (
        <CheckRow label={block.label} state={{ status: "static" }} />
      );
    case "action":
      return renderAction ? renderAction({ id: block.id, label: block.label }) : null;
  }
}
