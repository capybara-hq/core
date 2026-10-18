import { Button, IconButton } from "../controls/index.js";
import { Metric, type MetricProps } from "../display/index.js";
import { Menu, type MenuItem, Popover } from "../overlays/index.js";
import { useDesignLink, useDesignT } from "../provider.js";
import { useMediaQuery } from "./use-media-query.js";

export type HeaderAction =
  | {
      label: string;
      variant: "primary" | "secondary" | "default";
      onSelect?(): void;
      href?: string;
      shortcut?: string;
    }
  | { menu: MenuItem[]; label: string };

export type PageHeaderProps = {
  parent?: { label: string; href: string };
  title: string;
  count?: React.ReactNode;
  status?: React.ReactNode;
  metrics?: MetricProps[];
  actions?: HeaderAction[];
};

/** spec §4.2：指标 ≤5、实心主操作 ≤1。开发与测试抛错，生产只 console.error。 */
export function assertHeader(p: PageHeaderProps): void {
  const problems: string[] = [];
  if ((p.metrics?.length ?? 0) > 5) problems.push("PageHeader: metrics must be <= 5");
  const primaries = (p.actions ?? []).filter((a) => "variant" in a && a.variant === "primary");
  if (primaries.length > 1) problems.push("PageHeader: at most one primary action");
  if (problems.length === 0) return;
  const msg = problems.join("; ");
  if (process.env.NODE_ENV === "production") console.error(msg);
  else throw new Error(msg);
}

export function PageHeader(p: PageHeaderProps) {
  assertHeader(p);
  const t = useDesignT();
  const Link = useDesignLink();
  const narrow = useMediaQuery("(max-width: 639px)");
  const metrics = p.metrics ?? [];
  return (
    <div className="cb-pageheader">
      <div className="cb-pageheader-left">
        {p.parent ? (
          <Link href={p.parent.href} className="cb-pageheader-parent">
            {`${p.parent.label} /`}
          </Link>
        ) : null}
        <h1 className="cb-pageheader-title" title={p.title}>
          {p.title}
        </h1>
        {p.count != null && p.count !== false ? (
          <span className="cb-pageheader-count">{p.count}</span>
        ) : null}
        {p.status != null && p.status !== false ? (
          <span className="cb-pageheader-count">{p.status}</span>
        ) : null}
      </div>
      {metrics.length > 0 ? (
        narrow ? (
          <Popover trigger={<IconButton label={t("shell.metrics")} icon="⋯" size={28} />}>
            <div className="cb-pageheader-metrics-pop">
              {metrics.map((m) => (
                <Metric key={m.label} {...m} />
              ))}
            </div>
          </Popover>
        ) : (
          <div className="cb-pageheader-metrics">
            {metrics.map((m) => (
              <Metric key={m.label} {...m} />
            ))}
          </div>
        )
      ) : null}
      <div className="cb-pageheader-actions">
        {(p.actions ?? []).map((a) => {
          if ("menu" in a) {
            return (
              <Menu
                key={a.label}
                items={a.menu}
                trigger={<IconButton label={a.label} icon="⋯" size={28} variant="default" />}
              />
            );
          }
          if (a.href) {
            return (
              <Link
                key={a.label}
                href={a.href}
                className={`cb-btn cb-btn-link cb-btn-link-${a.variant}`}
              >
                {a.label}
              </Link>
            );
          }
          return (
            <Button
              key={a.label}
              variant={a.variant}
              {...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {})}
              {...(a.onSelect ? { onClick: a.onSelect } : {})}
            >
              {a.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
