import type { ElementType, ReactNode } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "./box";

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

export function Grid({
  columns,
  gap = 16,
  divided,
  children,
}: {
  /**
   * `list-detail`: a 220 px list beside a flexible detail (a file list and the open file's
   * editor), top-aligned; one column below 640, the list above the detail.
   */
  columns: 1 | 2 | 3 | 4 | "form" | "list-detail";
  gap?: Gap;
  /**
   * A `line-soft` column divider between the columns, `gap` from each side (a list beside the
   * open item's fields in one box, spec §5.8 "List + editor"); a row divider once they stack.
   */
  divided?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="cb-grid"
      data-columns={columns}
      data-gap={gap}
      data-divided={divided ? "true" : undefined}
    >
      {children}
    </div>
  );
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
    <section className="cb-card" data-part="card" data-tone={tone}>
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
