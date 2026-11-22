import { type ReactNode, useState } from "react";
import { Button, IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { BottomSheet, Sheet } from "../overlays/index";
import { useDesignT } from "../provider";
import { ClassForms, useClassForm } from "./class-forms";
import { INLINE_RIGHT_AREA_BELOW } from "./size-class";
import { useHydrated, useMediaQuery } from "./use-media-query";

export type BodyProps = {
  layout: "single" | "rail" | "inspector" | "rail-inspector" | "centered";
  rail?: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  /**
   * Sections (forms, settings, wizards) sit space.6 apart instead of space.3. Every body is the
   * one content width (`layout.content`, spec §4.3), centered.
   */
  loose?: boolean;
  /** `content` (default for frame templates): the one content width; `full`: the whole width. */
  width?: "content" | "full";
  /** Content inner padding (detail sections, cards); without it the content sits flush. */
  contentPadded?: boolean;
  /** Rail 内容贴边（自带内边距或本身是列表 / 表格时）；缺省内边距 12 16。 */
  railFlush?: boolean;
  /** Default true: the inline rail has a collapse button above it. false: the rail always shows. */
  railCollapsible?: boolean;
  /**
   * A header drawn at the top of the content column, beside the rail (SettingsPage): it stays
   * fixed above the content's scroll area and lines up with the content frame.
   */
  head?: ReactNode;
  /**
   * Field filters (ListPage `filters`) that join the Filter sheet on compact (responsive system
   * spec §2.2 level 3): below 600 a Filter button opens one bottom sheet holding them and the rail.
   * From 600 the template draws them inline itself; the Body draws nothing for them.
   */
  filters?: ReactNode;
  /** The number of active filters, shown on the Filter button (0 or absent: none). */
  filterCount?: number;
  children?: ReactNode;
};

export function Body({
  layout,
  rail,
  inspector,
  inspectorTitle,
  onInspectorClose,
  loose,
  width = "full",
  contentPadded,
  railFlush,
  railCollapsible = true,
  head,
  filters,
  filterCount,
  children,
}: BodyProps) {
  const t = useDesignT();
  // The inspector is the right area: inline from 1280, a sheet below (window width). The facet
  // rail follows the "side columns fit" rule instead (spec §4.3): inline while the body leaves
  // `layout.content-min` beside it, else a Filter button and a sheet. Both forms are always drawn
  // and a container query on the body (`@container cb-frame`) shows one, so the server render is
  // right without JS and a sidebar, rail or pane that changes the room is followed live.
  const narrowInspector = useMediaQuery(INLINE_RIGHT_AREA_BELOW);
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const hasRail = (layout === "rail" || layout === "rail-inspector") && rail != null;
  const hasInspector = (layout === "inspector" || layout === "rail-inspector") && inspector != null;
  const inspectorInSheet = hasInspector && narrowInspector;
  // Before hydration both forms are drawn and CSS media queries show one (`data-responsive`), so
  // the first paint is right at every width (no 240 rail beside the content below 1280).
  const pre = !useHydrated();
  const railInline = hasRail;
  const railButton = hasRail;
  const inspectorInline = hasInspector && (pre || !inspectorInSheet);
  const inspectorButton = hasInspector && (pre || inspectorInSheet);
  const resp = (v: string) => (pre ? v : undefined);
  // Field filters join the Filter sheet on compact only (the template draws them inline from 600).
  const form = useClassForm();
  const hasFilters = filters != null && filters !== false;
  const filterOnly = hasFilters && !railButton;
  const filterButton = (
    <Button onClick={() => setRailOpen(true)}>
      {t("shell.filter")}
      {hasFilters && (filterCount ?? 0) > 0 ? (
        <span className="cb-body-tool-count" data-part="filter-count">
          <span aria-hidden="true">{filterCount}</span>
          <span className="cb-sr-only">
            {` ${t("shell.filterActive").replace("{n}", String(filterCount))}`}
          </span>
        </span>
      ) : null}
    </Button>
  );

  if (layout === "centered") {
    return (
      <div className="cb-body" data-layout="centered">
        <div className="cb-body-content">
          <div
            className="cb-body-frame"
            data-part="content"
            data-width={width}
            data-gap={loose ? "loose" : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    );
  }

  const content = (
    <div className="cb-body-content" data-padded={contentPadded ? "true" : undefined}>
      <div
        className="cb-body-frame"
        data-part="content"
        data-width={width}
        data-gap={loose ? "loose" : undefined}
      >
        {children}
      </div>
    </div>
  );

  return (
    <div className="cb-body" data-layout={layout}>
      {railButton || inspectorButton ? (
        // With a rail the container carries no width rule: the Filter button follows the container
        // query (`data-rail-fit`) and only the inspector's own tool follows the window
        // (`below-1280`). Without a rail the inspector's tool is the container's only content, so
        // the container itself goes with it at 1280 and up.
        <div
          className="cb-body-tools"
          data-responsive={hasInspector && !railButton ? resp("below-1280") : undefined}
          data-rail-fit={hasInspector ? undefined : "button"}
        >
          {railButton ? (
            <span className="cb-body-tool" data-rail-fit="button">
              {filterButton}
            </span>
          ) : null}
          {filterOnly ? (
            <ClassForms
              compact={<span className="cb-body-tool">{filterButton}</span>}
              wide={null}
            />
          ) : null}
          {inspectorButton ? (
            <span className="cb-body-tool" data-responsive={resp("below-1280")}>
              <Button onClick={() => setInspectorOpen(true)}>{t("shell.details")}</Button>
            </span>
          ) : null}
        </div>
      ) : filterOnly ? (
        // Field filters alone: the Filter button exists on compact only.
        <ClassForms
          compact={
            <div className="cb-body-tools" data-part="body-filter-tools">
              <span className="cb-body-tool">{filterButton}</span>
            </div>
          }
          wide={null}
        />
      ) : null}
      <div className="cb-body-row">
        {railInline ? (
          railCollapsed ? (
            <div className="cb-body-rail-collapsed" data-rail-fit="inline">
              <IconButton
                label={t("shell.railExpand")}
                icon={<Icon name="chevrons-right" />}
                density="default"
                onClick={() => setRailCollapsed(false)}
              />
            </div>
          ) : (
            <aside className="cb-body-rail" data-part="rail" data-rail-fit="inline">
              {railCollapsible ? (
                <div className="cb-body-rail-head">
                  <IconButton
                    label={t("shell.railCollapse")}
                    icon={<Icon name="chevrons-left" />}
                    density="default"
                    onClick={() => setRailCollapsed(true)}
                  />
                </div>
              ) : null}
              {railFlush ? rail : <div className="cb-body-rail-inner">{rail}</div>}
            </aside>
          )
        ) : null}
        {head ? (
          <div className="cb-body-main">
            {head}
            {content}
          </div>
        ) : (
          content
        )}
        {inspectorInline ? (
          <aside className="cb-body-inspector" data-responsive={resp("from-1280")}>
            {onInspectorClose ? (
              <div className="cb-body-inspector-head">
                <IconButton
                  label={t("shell.inspectorClose")}
                  icon={<Icon name="x" />}
                  density="default"
                  onClick={onInspectorClose}
                />
              </div>
            ) : null}
            <div className="cb-body-inspector-inner">{inspector}</div>
          </aside>
        ) : null}
      </div>
      {form === "compact" && (hasRail || hasFilters) ? (
        // Compact: one Filter bottom sheet holds the field filters and the rail (spec §2.2).
        <BottomSheet
          open={railOpen}
          onOpenChange={setRailOpen}
          title={t("shell.filter")}
          part="filter-sheet"
        >
          {hasFilters ? <div className="cb-body-filter-fields">{filters}</div> : null}
          {hasRail ? rail : null}
        </BottomSheet>
      ) : hasRail ? (
        <Sheet open={railOpen} onOpenChange={setRailOpen} title={t("shell.filter")}>
          {rail}
        </Sheet>
      ) : null}
      {inspectorInSheet ? (
        <Sheet
          open={inspectorOpen}
          onOpenChange={setInspectorOpen}
          title={inspectorTitle ?? t("shell.details")}
        >
          {inspector}
        </Sheet>
      ) : null}
    </div>
  );
}
