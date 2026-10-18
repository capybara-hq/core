import type { ElementType, ReactNode } from "react";

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
  children,
}: {
  columns: 1 | 2 | 3 | 4 | "form";
  gap?: Gap;
  children?: ReactNode;
}) {
  return (
    <div className="cb-grid" data-columns={columns} data-gap={gap}>
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
  tone?: "default" | "danger";
  children?: ReactNode;
}) {
  return (
    <section className="cb-card" data-tone={tone}>
      {title || actions ? (
        <header className="cb-card-head">
          <div className="cb-card-title">{title}</div>
          {actions ? <div className="cb-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="cb-card-body">{children}</div>
    </section>
  );
}

export function Text({
  variant = "body",
  tone = "ink",
  as,
  truncate,
  pre,
  children,
}: {
  variant?: "h1" | "h2" | "body" | "small" | "micro";
  tone?: "ink" | "muted" | "faint" | "accent" | "ok" | "fail" | "warn";
  as?: ElementType;
  truncate?: boolean;
  /** 保留换行与连续空白（消息正文、日志等多行文本），超长单词折行。 */
  pre?: boolean;
  children?: ReactNode;
}) {
  const Tag: ElementType = as ?? (variant === "h1" ? "h1" : variant === "h2" ? "h2" : "span");
  const title =
    truncate && (typeof children === "string" || typeof children === "number")
      ? String(children)
      : undefined;
  return (
    <Tag
      className="cb-text"
      data-variant={variant}
      data-tone={tone}
      data-truncate={truncate ? "true" : undefined}
      data-pre={pre ? "true" : undefined}
      title={title}
    >
      {children}
    </Tag>
  );
}
