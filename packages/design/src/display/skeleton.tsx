import { createContext, type ReactNode, useContext } from "react";
import { useDesignT } from "../provider";

/** True inside a {@link SkeletonGroup}: the group already announces the load. */
const InGroup = createContext(false);

/**
 * Whether a loading component announces on its own: false inside a {@link SkeletonGroup}, which
 * speaks once for everything in it (spec §6.29).
 */
export function useSkeletonAnnounces(): boolean {
  return !useContext(InGroup);
}

/** The hidden "正在加载 / Loading" a busy region carries. */
export function SkeletonAnnouncement() {
  const t = useDesignT();
  return <span className="cb-sr-only">{t("table.loading")}</span>;
}

export type SkeletonTextSize = "body" | "small" | "title" | "metric" | "heading";
export type SkeletonTextWidth = "30%" | "45%" | "55%" | "70%" | "100%" | number;

const px = (w: SkeletonTextWidth) => (typeof w === "number" ? `${w}px` : w);

/**
 * One text placeholder (spec §6.29): a slot exactly one line box of its type size high (`body`,
 * `small`, `title` (the h1 size), `heading` (the h2 size) or `metric` (the StatCard value size)), so the layout is the
 * loaded one, holding a bar (`space.3` high, `selected`, radius `sm`) centred in it. `width` is the slot's and the bar's. Decorative:
 * the group announces.
 */
export function SkeletonText({
  width,
  size = "body",
}: {
  width: SkeletonTextWidth;
  size?: SkeletonTextSize;
}) {
  return (
    <span
      className="cb-skeleton-text"
      data-part="skeleton-text"
      data-size={size}
      style={{ width: px(width) }}
      aria-hidden="true"
    >
      <span className="cb-skeleton-bar" data-part="skeleton-bar" />
    </span>
  );
}

export type SkeletonBoxPart = "dense" | "default" | "prominent" | "mark" | "block";

/**
 * A block shaped like a control or a mark (spec §6.29), on the `selected` ground. `dense`,
 * `default` and `prominent` take the control height; `mark` is the 36 px object mark; `block`
 * takes `height` (pixels, default 96). `width` is in pixels and defaults to the container.
 */
export function SkeletonBox({
  part,
  height,
  width,
}: {
  part: SkeletonBoxPart;
  height?: number;
  width?: number;
}) {
  return (
    <span
      className="cb-skeleton-box"
      data-part="skeleton-box"
      data-box={part}
      style={{
        ...(width !== undefined ? { width: `${width}px` } : {}),
        ...(height !== undefined ? { height: `${height}px` } : {}),
      }}
      aria-hidden="true"
    />
  );
}

/**
 * The busy region of a loading page or panel (spec §6.29): `aria-busy`, named by `label`, with
 * one hidden "正在加载 / Loading". A group inside a group adds nothing, so a template that draws
 * several loading parts announces once.
 */
export function SkeletonGroup({ label, children }: { label: string; children: ReactNode }) {
  const nested = useContext(InGroup);
  if (nested) return <div className="cb-skeleton-group">{children}</div>;
  return (
    <InGroup.Provider value={true}>
      <div className="cb-skeleton-group" role="status" aria-label={label} aria-busy="true">
        <SkeletonAnnouncement />
        {children}
      </div>
    </InGroup.Provider>
  );
}
