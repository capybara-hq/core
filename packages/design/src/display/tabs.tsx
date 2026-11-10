import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { ControlA11y } from "../controls/a11y";
import { type Density, useDensity } from "../controls/density";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";

export type TabItem = {
  id: string;
  label: string;
  count?: number | string;
  /** The count is not known yet (the list is loading): a muted dash in its place. */
  pending?: boolean;
  /** 标签名后的计数徽标（如「2/4」），比 count 更醒目。 */
  badge?: string;
  /** 提醒标记（主色方点 + 读屏文字），如有待批准的操作。 */
  alert?: boolean;
  disabled?: boolean;
  href?: string;
};

function TabExtras({ it }: { it: TabItem }) {
  const t = useDesignT();
  return (
    <>
      {it.pending ? (
        <span className="cb-tab-count" data-pending="true">
          –
        </span>
      ) : it.count !== undefined ? (
        <span className="cb-tab-count">{it.count}</span>
      ) : null}
      {it.badge !== undefined ? <span className="cb-tab-badge">{it.badge}</span> : null}
      {it.alert ? (
        <span className="cb-tab-alert" data-alert="true">
          <span className="cb-tab-alert-mark" aria-hidden="true" />
          <span className="cb-sr-only">{t("tabs.alert")}</span>
        </span>
      ) : null}
    </>
  );
}

/** Keys that alone do not count as keyboard use (they leave a pointer focus mark in place). */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "OS"]);

export type TabsProps = {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  label: string;
};

/** Which edges of a sideways-scrolling row hide tabs (none until measured, and in a server render). */
type ScrollEdges = { start: boolean; end: boolean };

/**
 * Follows a tab row's horizontal overflow (spec §6.4): which edges have tabs scrolled out of view,
 * so the row fades there (the scroll hint on a phone, where the tabs do not fit). Updated on
 * scroll and on a resize of the row or its tabs.
 */
function useScrollEdges(ref: RefObject<HTMLElement | null>, deps: unknown): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` re-measures after the tabs change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [ref, deps]);
  return edges;
}

const edgeAttrs = (e: ScrollEdges) => ({
  "data-fade-start": e.start ? "true" : undefined,
  "data-fade-end": e.end ? "true" : undefined,
});

export function Tabs({ items, value, onChange, label }: TabsProps) {
  const Link = useDesignLink();
  const ref = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const hasLinks = items.some((i) => i.href);
  const edges = useScrollEdges(hasLinks ? navRef : ref, `${hasLinks}:${items.length}`);
  // The tab a pointer focused: it draws no ring (spec §2.5), until a key press or a blur. A press
  // only arms it (`pressed`); the mark is set when focus arrives from that press, in the same
  // task. WebKit and Firefox on macOS do not focus a clicked button, so an armed press that gives
  // no focus is dropped on pointerup or the next tick, and a later keyboard focus keeps its ring.
  const [pointerFocus, setPointerFocus] = useState<string | null>(null);
  const pressed = useRef<string | null>(null);
  const press = (id: string, el: HTMLElement) => {
    // A press on the tab that already has focus moves no focus, so no focus event comes: Chrome
    // keeps that focus's keyboard origin (and its ring), so the mark is set at once.
    if (document.activeElement === el) {
      setPointerFocus(id);
      return;
    }
    pressed.current = id;
    setTimeout(() => {
      if (pressed.current === id) pressed.current = null;
    }, 0);
  };

  if (hasLinks) {
    return (
      <nav className="cb-tabs" aria-label={label} ref={navRef} {...edgeAttrs(edges)}>
        {items.map((it) => {
          const current = it.id === value;
          if (it.disabled || !it.href) {
            return (
              // biome-ignore lint/a11y/useValidAnchor: 禁用项无 href
              <a
                key={it.id}
                className="cb-tab"
                aria-disabled={true}
                data-state={current ? "selected" : "disabled"}
              >
                {it.label}
                <TabExtras it={it} />
              </a>
            );
          }
          return (
            <Link
              key={it.id}
              className="cb-tab"
              href={it.href}
              aria-current={current ? "page" : undefined}
            >
              {it.label}
              <TabExtras it={it} />
              <LinkPendingMark />
            </Link>
          );
        })}
      </nav>
    );
  }

  const enabled = items.filter((i) => !i.disabled);
  // value 不对应任何可用页签时，第一个可用页签可被 Tab 聚焦（否则整个页签栏不可达）
  const focusId = enabled.some((i) => i.id === value) ? value : enabled[0]?.id;
  const onKey = (e: KeyboardEvent) => {
    // A key press is keyboard use: the ring shows again. A modifier alone is not (Chrome does not
    // turn on :focus-visible for one either).
    if (!MODIFIER_KEYS.has(e.key)) setPointerFocus(null);
    const idx = enabled.findIndex((i) => i.id === focusId);
    let next: TabItem | undefined;
    if (e.key === "ArrowRight") next = enabled[(idx + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange?.(next.id);
    ref.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <div
      className="cb-tabs"
      role="tablist"
      aria-label={label}
      ref={ref}
      onKeyDown={onKey}
      {...edgeAttrs(edges)}
    >
      {items.map((it) => {
        const selected = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            className="cb-tab"
            data-part="tab"
            data-id={it.id}
            aria-selected={selected}
            tabIndex={it.id === focusId ? 0 : -1}
            disabled={it.disabled}
            data-state={selected ? "selected" : undefined}
            data-pointer-focus={pointerFocus === it.id ? "true" : undefined}
            onPointerDown={(e) => press(it.id, e.currentTarget)}
            onPointerUp={() => {
              pressed.current = null;
            }}
            onPointerCancel={() => {
              pressed.current = null;
            }}
            onFocus={() => {
              if (pressed.current === it.id) setPointerFocus(it.id);
              pressed.current = null;
            }}
            onBlur={() => setPointerFocus((p) => (p === it.id ? null : p))}
            onClick={() => onChange?.(it.id)}
          >
            {it.label}
            <TabExtras it={it} />
          </button>
        );
      })}
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  label,
  density,
  fill,
  ...a11y
}: ControlA11y & {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  density?: Density;
  /** Take the container's width with equal segments (a form field, spec §6.4). */
  fill?: boolean;
}) {
  const step = useDensity(density);
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const idx = options.findIndex((o) => o.value === value);
    let next: { value: string } | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = options[(idx + 1) % options.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = options[(idx - 1 + options.length) % options.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      {...a11y}
      className="cb-segmented"
      data-part="segmented"
      data-cap-part="segmented"
      data-density={step}
      data-fill={fill ? "true" : undefined}
      role="radiogroup"
      aria-label={label}
      ref={ref}
      onKeyDown={onKey}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: 分段按钮使用 role=radio
          <button
            key={o.value}
            type="button"
            role="radio"
            className="cb-seg"
            data-part="segment"
            data-value={o.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-state={selected ? "selected" : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
