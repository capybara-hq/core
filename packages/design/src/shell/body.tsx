import { type ReactNode, useState } from "react";
import { Button, IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { Sheet } from "../overlays/index";
import { useDesignT } from "../provider";
import { useHydrated, useMediaQuery } from "./use-media-query";

export type BodyProps = {
  layout: "single" | "rail" | "inspector" | "rail-inspector" | "centered";
  rail?: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  /**
   * The content's max width (spec §4.3): `list` `layout.content-list`, `form`
   * `layout.content-form`, centered; `full` the whole width (the default).
   */
  width?: "list" | "form" | "full";
  /** Content inner padding (detail sections, cards); without it the content sits flush. */
  contentPadded?: boolean;
  /** Rail 内容贴边（自带内边距或本身是列表 / 表格时）；缺省内边距 12 16。 */
  railFlush?: boolean;
  children?: ReactNode;
};

export function Body({
  layout,
  rail,
  inspector,
  inspectorTitle,
  onInspectorClose,
  width = "full",
  contentPadded,
  railFlush,
  children,
}: BodyProps) {
  const t = useDesignT();
  const narrowInspector = useMediaQuery("(max-width: 1279px)");
  const narrowRail = useMediaQuery("(max-width: 959px)");
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const hasRail = (layout === "rail" || layout === "rail-inspector") && rail != null;
  const hasInspector = (layout === "inspector" || layout === "rail-inspector") && inspector != null;
  const railInSheet = hasRail && narrowRail;
  const inspectorInSheet = hasInspector && narrowInspector;
  // Before hydration both forms are drawn and CSS media queries show one (`data-responsive`), so
  // the first paint is right at every width (no 240 rail beside the content below 960).
  const pre = !useHydrated();
  const railInline = hasRail && (pre || !railInSheet);
  const railButton = hasRail && (pre || railInSheet);
  const inspectorInline = hasInspector && (pre || !inspectorInSheet);
  const inspectorButton = hasInspector && (pre || inspectorInSheet);
  const resp = (v: string) => (pre ? v : undefined);

  if (layout === "centered") {
    return (
      <div className="cb-body" data-layout="centered">
        <div className="cb-body-content">
          <div className="cb-body-frame" data-part="content" data-width={width}>
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cb-body" data-layout={layout}>
      {railButton || inspectorButton ? (
        <div
          className="cb-body-tools"
          data-responsive={resp(hasInspector ? "below-1280" : "below-960")}
        >
          {railButton ? (
            <span className="cb-body-tool" data-responsive={resp("below-960")}>
              <Button onClick={() => setRailOpen(true)}>{t("shell.filter")}</Button>
            </span>
          ) : null}
          {inspectorButton ? (
            <span className="cb-body-tool" data-responsive={resp("below-1280")}>
              <Button onClick={() => setInspectorOpen(true)}>{t("shell.details")}</Button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="cb-body-row">
        {railInline ? (
          railCollapsed ? (
            <div className="cb-body-rail-collapsed" data-responsive={resp("from-960")}>
              <IconButton
                label={t("shell.railExpand")}
                icon={<Icon name="chevrons-right" />}
                density="default"
                onClick={() => setRailCollapsed(false)}
              />
            </div>
          ) : (
            <aside className="cb-body-rail" data-responsive={resp("from-960")}>
              <div className="cb-body-rail-head">
                <IconButton
                  label={t("shell.railCollapse")}
                  icon={<Icon name="chevrons-left" />}
                  density="default"
                  onClick={() => setRailCollapsed(true)}
                />
              </div>
              {railFlush ? rail : <div className="cb-body-rail-inner">{rail}</div>}
            </aside>
          )
        ) : null}
        <div className="cb-body-content" data-padded={contentPadded ? "true" : undefined}>
          <div className="cb-body-frame" data-part="content" data-width={width}>
            {children}
          </div>
        </div>
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
      {railInSheet ? (
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
