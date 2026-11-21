import { Fragment, type ReactNode } from "react";

const MARK = "\u0001";

/**
 * A translated line with a node (a person's avatar and name) where one placeholder stands:
 * `render` formats the message with the placeholder set to the given mark, and the node takes the
 * mark's place. (A plain `{who}` placeholder takes text only; this keeps the message untouched.)
 */
export function withNode(render: (mark: string) => string, node: ReactNode): ReactNode {
  const [head = "", ...tail] = render(MARK).split(MARK);
  return (
    <>
      {head}
      <Fragment key="slot">{node}</Fragment>
      {tail.join(MARK)}
    </>
  );
}
