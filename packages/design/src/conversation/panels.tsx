import type { CSSProperties, JSX, ReactNode } from "react";
import { Button, IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignT } from "../provider";
import { LoadFailed } from "./file-preview";
import { TypeBadge } from "./files";
import { ConvMenu, type ConvMenuEntry } from "./menu";
import { fillCopy } from "./tool-copy";

// The extension slots and side areas of the conversation page (spec §6.16.16–§6.16.18): the
// inline card, the properties panel and its sections, and the right panel. An extension block that
// fails shows the load-failure line in that block only.

export type BlockState = "ready" | "loading" | "failed";

/** Skeleton bars (`selected`, radius `sm`, `aria-busy`): loading never spins in a block. */
export function SkeletonBars({ widths = [56, 72, 48, 64] }: { widths?: number[] }): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-skeleton-list" role="status" aria-busy="true" aria-label={t("card.loading")}>
      {widths.map((w, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are positional
          key={i}
          className="cb-skeleton-bar"
          data-part="skeleton-bar"
          style={{ "--cb-skeleton-w": `${w}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}

// ── Inline card (§6.16.16) ──────────────────────────────────────────────────

export type InlineCardProps = {
  /** The extension's name: "来自 <source> 的卡片". */
  source: string;
  /** Overrides the title line (stage B2 widgets: "Widget <tool> from <connector>"). */
  title?: string;
  /** The view's badge at the right in `faint` ("2 / 5"). */
  badge?: string;
  /** A live embed: "实时" in `muted`. */
  live?: boolean;
  /** The extension has a right panel: ⤢ opens it. */
  onExpand?(): void;
  state: BlockState;
  failure?: { reason?: string };
  onRetry?(): void;
  /** An embed (EmbedFrame) rather than a rendered view. */
  embed?: boolean;
  children?: ReactNode;
};

export function InlineCard({
  source,
  title,
  badge,
  live,
  onExpand,
  state,
  failure,
  onRetry,
  embed,
  children,
}: InlineCardProps): JSX.Element {
  const t = useDesignT();
  let body: ReactNode;
  if (state === "loading") body = <SkeletonBars />;
  else if (state === "failed")
    body = (
      <LoadFailed
        name={source}
        {...(failure?.reason ? { reason: failure.reason } : {})}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  else body = children;
  return (
    <div className="cb-icard-block">
      <div className="cb-tool-line cb-icard-head" data-part="inline-card-head">
        <span className="cb-tool-label">{title ?? fillCopy(t("card.from"), { name: source })}</span>
        <span className="cb-icard-grow" />
        {badge ? <span className="cb-faint">{badge}</span> : null}
        {live ? <span className="cb-muted">{t("card.live")}</span> : null}
        {onExpand ? (
          <IconButton
            density="dense"
            label={t("card.openInPanel")}
            icon={<Icon name="maximize-2" size={14} />}
            onClick={onExpand}
          />
        ) : null}
      </div>
      <div
        className="cb-icard"
        data-part="inline-card"
        data-embed={embed ? "true" : undefined}
        data-state={state}
      >
        {body}
      </div>
    </div>
  );
}

/** A checklist view (todo's card, section and panel): done struck through, the current one dotted. */
export function TaskList({
  items,
  size = "default",
}: {
  items: { id?: string; text: string; state: "done" | "current" | "todo" }[];
  size?: "default" | "large";
}): JSX.Element {
  const t = useDesignT();
  return (
    <ul className="cb-task-list" data-size={size === "large" ? "large" : undefined}>
      {items.map((it, i) => (
        <li key={it.id ?? i} data-state={it.state}>
          {it.state === "current" ? <span className="cb-task-dot" aria-hidden="true" /> : null}
          {it.text}
          {it.state === "done" ? (
            <span className="cb-sr-only">{`（${t("conv.taskDone")}）`}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ── Properties panel (§6.16.17) ─────────────────────────────────────────────

/** The properties panel: `layout.properties` wide, its sections `space.2` apart, scrolling alone. */
export function PropertiesPanel({ children }: { children?: ReactNode }): JSX.Element {
  const t = useDesignT();
  return (
    <aside className="cb-properties" data-part="properties" aria-label={t("props.label")}>
      {children}
    </aside>
  );
}

export type PropertySectionProps = {
  title: string;
  /** The value at the right of the head ("43%", "6", "2 / 4"). */
  value?: ReactNode;
  /** `muted` value (counts) rather than `ink` (the context ratio). */
  valueTone?: "ink" | "muted";
  state?: BlockState;
  failure?: { reason?: string };
  onRetry?(): void;
  children?: ReactNode;
};

/** One section: `panel` ground, radius `md`, padding `space.3`, the head over the body. */
export function PropertySection({
  title,
  value,
  valueTone = "muted",
  state = "ready",
  failure,
  onRetry,
  children,
}: PropertySectionProps): JSX.Element {
  let body: ReactNode = children;
  if (state === "loading") body = <SkeletonBars widths={[64, 48]} />;
  if (state === "failed")
    body = (
      <LoadFailed
        name={title}
        {...(failure?.reason ? { reason: failure.reason } : {})}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  return (
    <section className="cb-property-section" data-part="property-section" data-state={state}>
      <h3 className="cb-property-head">
        <span className="cb-property-title" data-part="property-title">
          {title}
        </span>
        {value !== undefined && state !== "failed" ? (
          <span className={valueTone === "muted" ? "cb-muted" : undefined}>{value}</span>
        ) : null}
      </h3>
      {body}
    </section>
  );
}

/** The built-in Context section: the usage meter, model · sandbox, connectors. */
export function ContextSection({
  ratio,
  model,
  sandbox,
  connectors,
}: {
  /** Context usage in percent (0–100). */
  ratio: number;
  model: string;
  sandbox?: string;
  connectors: string[];
}): JSX.Element {
  const t = useDesignT();
  const pct = Math.max(0, Math.min(100, Math.round(ratio)));
  return (
    <PropertySection title={t("props.context")} value={`${pct}%`} valueTone="ink">
      {/* biome-ignore lint/a11y/useSemanticElements: a <meter> can't take the token track and fill */}
      <div
        className="cb-meter"
        data-part="meter"
        role="meter"
        aria-label={t("props.context")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="cb-muted cb-small">{[model, sandbox].filter(Boolean).join(" · ")}</div>
      {connectors.length > 0 ? (
        <div className="cb-muted cb-small">
          {fillCopy(t("props.connectors"), { list: connectors.join(t("props.listJoin")) })}
        </div>
      ) : null}
    </PropertySection>
  );
}

/** The built-in Files section: up to `max` rows, then "全部 N 个文件 ›". */
export function FilesSection({
  files,
  total,
  max = 4,
  onOpen,
  onAll,
}: {
  files: { id: string; name: string; badge: string; size: string }[];
  total?: number;
  max?: number;
  onOpen(id: string): void;
  onAll(): void;
}): JSX.Element {
  const t = useDesignT();
  const n = total ?? files.length;
  return (
    <PropertySection title={t("props.files")} value={String(n)}>
      <div className="cb-property-list">
        {files.slice(0, max).map((f) => (
          <button
            key={f.id}
            type="button"
            className="cb-property-row"
            data-part="property-row"
            title={f.name}
            onClick={() => onOpen(f.id)}
          >
            <TypeBadge label={f.badge} />
            <span className="cb-property-name">{f.name}</span>
            <span className="cb-muted">{f.size}</span>
          </button>
        ))}
        <button type="button" className="cb-property-row cb-property-more" onClick={onAll}>
          {fillCopy(t("props.allFiles"), { n })}
          <Icon name="chevron-right" size={12} />
        </button>
      </div>
    </PropertySection>
  );
}

// ── Right panel (§6.16.18) ──────────────────────────────────────────────────

export type RightPanelSwitcher = {
  groups: {
    label?: string;
    items: { id: string; label: string; icon?: IconName; badge?: string }[];
  }[];
  current: string;
  onSwitch(id: string): void;
};

export type RightPanelProps = {
  title: string;
  /** A type badge before the title (files). */
  badge?: string;
  /** The title becomes a menu of what else can be open; plain text without it. */
  switcher?: RightPanelSwitcher;
  /** Meta after the title in `small` `faint` ("v2 · 刚刚", "2 / 4", a spinner and a duration). */
  meta?: ReactNode;
  onBack?(): void;
  /** Header actions before full screen and close (icon buttons, Stop). */
  actions?: ReactNode;
  onFullscreen(): void;
  onClose(): void;
  state?: BlockState;
  failure?: { name?: string; reason?: string };
  onRetry?(): void;
  /** Body padding: `space.4` (default), none (tables, previews) or the sub-agent's `space.4 space.5`. */
  body?: "pad" | "flush" | "subagent";
  /** A footer under the body (the sub-agent's status bar). */
  footer?: ReactNode;
  /** Accessible name of the panel (default: the title). */
  label?: string;
  /** The reference set only: the switcher drawn open in place. */
  referenceSwitcherOpen?: boolean;
  children?: ReactNode;
};

/** One right panel: an extension panel, a file or a sub-agent; full height, `panel-2`. */
export function RightPanel({
  title,
  badge,
  switcher,
  meta,
  onBack,
  actions,
  onFullscreen,
  onClose,
  state = "ready",
  failure,
  onRetry,
  body = "pad",
  footer,
  label,
  referenceSwitcherOpen,
  children,
}: RightPanelProps): JSX.Element {
  const t = useDesignT();
  const entries: ConvMenuEntry[] = [];
  switcher?.groups.forEach((g, gi) => {
    if (gi > 0) entries.push({ kind: "separator" });
    if (g.label) entries.push({ kind: "label", label: g.label });
    for (const it of g.items) {
      entries.push({
        kind: "item",
        id: it.id,
        label: it.label,
        ...(it.badge ? { icon: <TypeBadge label={it.badge} /> } : it.icon ? { icon: it.icon } : {}),
        checked: it.id === switcher.current,
        checkMark: false,
        onSelect: () => switcher.onSwitch(it.id),
      });
    }
  });
  const titleNode = switcher ? (
    <ConvMenu
      inline={referenceSwitcherOpen === true}
      label={t("panel.switch")}
      size="wide"
      // The reference hangs the menu `space.1` above the head's bottom edge (title bar 48 − 4):
      // 6.5 below the 28-high button centred in the 47-high head.
      sideOffset={6.5}
      trigger={
        <Button variant="ghost" className="cb-rpanel-switch" aria-haspopup="menu">
          <span className="cb-rpanel-title-text">{title}</span>
          <Icon name="chevron-down" size={14} />
        </Button>
      }
      entries={entries}
    />
  ) : (
    <span className="cb-rpanel-title-text cb-rpanel-title-plain" data-part="panel-title">
      {title}
    </span>
  );
  let content: ReactNode = children;
  if (state === "failed")
    content = (
      <LoadFailed
        name={failure?.name ?? title}
        {...(failure?.reason ? { reason: failure.reason } : {})}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  if (state === "loading") content = <SkeletonBars />;
  return (
    <aside className="cb-rpanel" data-part="right-panel" aria-label={label ?? title}>
      <header className="cb-rpanel-head" data-part="panel-head">
        {onBack ? (
          <IconButton
            label={t("panel.back")}
            icon={<Icon name="chevron-left" size={16} />}
            onClick={onBack}
          />
        ) : null}
        {badge ? <TypeBadge label={badge} /> : null}
        {titleNode}
        {meta !== undefined ? (
          <span className="cb-faint cb-small cb-rpanel-meta" data-part="panel-meta">
            {meta}
          </span>
        ) : null}
        <span className="cb-rpanel-grow" />
        {actions}
        <IconButton
          label={t("panel.fullscreen")}
          icon={<Icon name="maximize-2" size={16} />}
          onClick={onFullscreen}
        />
        <IconButton
          label={t("overlay.close")}
          icon={<Icon name="x" size={16} />}
          onClick={onClose}
        />
      </header>
      <div
        className="cb-rpanel-body"
        data-part="panel-body"
        data-pad={state === "ready" ? body : "pad"}
        data-state={state}
        aria-busy={state === "loading" ? true : undefined}
      >
        {content}
      </div>
      {footer ? <div className="cb-rpanel-footer">{footer}</div> : null}
    </aside>
  );
}

/** Tabs at the top of a panel body (a workbook's sheets): `small`, the current one underlined. */
export function PanelTabs({
  items,
  current,
  onSelect,
  label,
}: {
  items: { id: string; label: string }[];
  current: string;
  onSelect(id: string): void;
  label: string;
}): JSX.Element {
  return (
    <div className="cb-panel-tabs" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          className="cb-panel-tab"
          aria-selected={it.id === current}
          tabIndex={it.id === current ? 0 : -1}
          onClick={() => onSelect(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
