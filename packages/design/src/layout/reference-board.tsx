import type { JSX } from "react";

/**
 * A stand-in for an extension's embed page (example-board's task board) in the reference blocks:
 * an embed is a remote iframe, so the catalog draws its content in place. Development catalog only.
 */
export function ReferenceBoard({
  columns,
}: {
  columns: { title: string; cards: { text: string; current?: boolean }[] }[];
}): JSX.Element {
  return (
    <div className="cb-ref-board">
      {columns.map((c) => (
        <div key={c.title} className="cb-ref-board-col">
          <div className="cb-ref-board-head">{c.title}</div>
          {c.cards.map((k) => (
            <div
              key={k.text}
              className="cb-ref-board-card"
              data-current={k.current ? "true" : undefined}
            >
              {k.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
