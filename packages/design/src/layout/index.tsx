import { Children, type ElementType, type ReactNode } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "./box";
import { ListDetail } from "./list-detail";

export type Gap = 0 | 4 | 8 | 12 | 16 | 24 | 32;

export function Stack({
  gap = 8,
  direction = "column",
  align,
  justify,
  wrap,
  children,
}: {
  gap?: Gap;
  direction?: "column" | "row";
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="cb-stack"
      data-gap={gap}
      data-direction={direction}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? "true" : undefined}
    >
      {children}
    </div>
  );
}

type GridColumns = 1 | 2 | 3 | 4 | "form" | "list-detail";

export type GridProps = {
  /**
   * `list-detail`: a 220 px list beside a flexible detail (a file list and the open file's
   * editor), top-aligned; one column below 600, the list above the detail.
   */
  columns: GridColumns;
  gap?: Gap;
  children?: ReactNode;
} & (
  | {
      columns: "list-detail";
      /**
       * A `line-soft` column divider between the list and the detail, `space.4` from each (a list
       * beside the open item's fields in one box, spec §5.8 "List + editor"); a row divider once
       * they stack below 600. Only for `list-detail`: its two children make one row.
       */
      divided?: boolean;
      /**
       * The list-detail region's open state (spec §6.47): with it the grid is a `ListDetail`, so
       * a frame narrower than the 220 list plus a 360 detail shows the list as the page and the
       * open item pushed over it (`onBack` closes it). Without it the two children stack, the
       * list above the detail.
       */
      open?: boolean;
      onBack?: () => void;
      /** The region's accessible name (with `open`). */
      label?: string;
    }
  | {
      columns: Exclude<GridColumns, "list-detail">;
      divided?: never;
      open?: never;
      onBack?: never;
      label?: never;
    }
);

/** The list column and the detail's least width of a `list-detail` grid: its fit is 580. */
const GRID_LIST = 220;
const GRID_DETAIL = 360;

export function Grid({ columns, gap = 16, divided, open, onBack, label, children }: GridProps) {
  const grid = (
    <div
      className="cb-grid"
      data-columns={columns}
      data-gap={gap}
      data-divided={divided ? "true" : undefined}
    >
      {children}
    </div>
  );
  if (columns !== "list-detail") return grid;
  const [list, detail] = Children.toArray(children);
  if (open !== undefined && list !== undefined && detail !== undefined) {
    return (
      <ListDetail
        list={list}
        detail={open ? detail : null}
        preview={detail}
        onBack={onBack ?? (() => {})}
        listMin={GRID_LIST}
        detailMin={GRID_DETAIL}
        label={label ?? ""}
        divided={divided === true}
        columns="list-detail"
      />
    );
  }
  // The columns fit by the frame's own width (spec §4.3), not the window's.
  return <div className="cb-grid-frame">{grid}</div>;
}

export function Card({
  title,
  actions,
  tone = "default",
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  /** danger：危险区块；accent：待人处理的对话卡片（审批 / 提问 / 连接，spec §6.9）。 */
  tone?: "default" | "danger" | "accent";
  children?: ReactNode;
}) {
  return (
    <CardFrame title={title} actions={actions} tone={tone}>
      {children}
    </CardFrame>
  );
}

/**
 * The Card's markup and box scope, for the design components that are a Card under another name
 * (OverviewSection, spec §5.6): `part` names it for the size tables, `state` is its `data-state`.
 * Not exported from the package.
 */
export function CardFrame({
  title,
  actions,
  tone = "default",
  part = "card",
  state,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  tone?: "default" | "danger" | "accent";
  part?: string;
  state?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <section
      className="cb-card"
      data-part={part}
      data-cap-part="card"
      data-tone={tone}
      data-state={state}
    >
      <BoxScope kind="card">
        {title || actions ? (
          <header className="cb-card-head">
            <div className="cb-card-title">{title}</div>
            {actions ? <div className="cb-card-actions">{actions}</div> : null}
          </header>
        ) : null}
        <div className="cb-card-body">{children}</div>
      </BoxScope>
    </section>
  );
}

export function Text({
  variant = "body",
  tone = "ink",
  as,
  truncate,
  pre,
  icon,
  title: titleText,
  children,
}: {
  /**
   * `prose`: running text (descriptions, hints, dialog bodies) in the proportional font,
   * `prose-small` 13 / 20 (spec §2.2); every other variant is the mono UI skeleton.
   */
  /** `h3`: a heading inside a box (a subsection, an open item's name): `body` size, 500. */
  variant?: "h1" | "h2" | "h3" | "body" | "small" | "micro" | "prose";
  tone?: "ink" | "muted" | "faint" | "accent" | "ok" | "fail" | "warn";
  as?: ElementType;
  truncate?: boolean;
  /** 保留换行与连续空白（消息正文、日志等多行文本），超长单词折行。 */
  pre?: boolean;
  /** A leading line icon (spec §2.4: a status is an icon plus text), such as `circle-x` for a failure. */
  icon?: IconName;
  /** A tooltip (the full value behind a short label); a truncated string already shows itself. */
  title?: string;
  children?: ReactNode;
}) {
  const Tag: ElementType =
    as ?? (variant === "h1" ? "h1" : variant === "h2" ? "h2" : variant === "h3" ? "h3" : "span");
  const title =
    titleText ??
    (truncate && (typeof children === "string" || typeof children === "number")
      ? String(children)
      : undefined);
  return (
    <Tag
      className="cb-text"
      data-variant={variant}
      data-tone={tone}
      data-truncate={truncate ? "true" : undefined}
      data-pre={pre ? "true" : undefined}
      title={title}
    >
      {icon ? <Icon name={icon} size={variant === "h1" || variant === "h2" ? 16 : 12} /> : null}
      {children}
    </Tag>
  );
}
