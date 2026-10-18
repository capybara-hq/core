import { type ReactNode, useState } from "react";
import { Button, IconButton } from "../controls/index.js";
import { Sheet } from "../overlays/index.js";
import { useDesignT } from "../provider.js";
import { useMediaQuery } from "./use-media-query.js";

export type BodyProps = {
  layout: "single" | "rail" | "inspector" | "rail-inspector" | "centered";
  rail?: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  anchors?: { id: string; label: string; error?: boolean }[];
  children?: ReactNode;
};

export function Body({
  layout,
  rail,
  inspector,
  inspectorTitle,
  onInspectorClose,
  anchors,
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

  if (layout === "centered") {
    return (
      <div className="cb-body" data-layout="centered">
        <div className="cb-body-centered">
          {anchors && anchors.length > 0 ? (
            <nav className="cb-body-anchors" aria-label={t("shell.anchors")}>
              {anchors.map((a) => (
                <a
                  key={a.id}
                  href={`#${a.id}`}
                  className="cb-body-anchor"
                  data-error={a.error ? "true" : undefined}
                >
                  {a.error ? `✗ ${a.label}` : a.label}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="cb-body-content cb-body-content-centered">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cb-body" data-layout={layout}>
      {railInSheet || inspectorInSheet ? (
        <div className="cb-body-tools">
          {railInSheet ? (
            <Button onClick={() => setRailOpen(true)}>{t("shell.filter")}</Button>
          ) : null}
          {inspectorInSheet ? (
            <Button onClick={() => setInspectorOpen(true)}>{t("shell.details")}</Button>
          ) : null}
        </div>
      ) : null}
      <div className="cb-body-row">
        {hasRail && !railInSheet ? (
          railCollapsed ? (
            <div className="cb-body-rail-collapsed">
              <IconButton
                label={t("shell.railExpand")}
                icon="»"
                size={28}
                onClick={() => setRailCollapsed(false)}
              />
            </div>
          ) : (
            <aside className="cb-body-rail">
              <div className="cb-body-rail-head">
                <IconButton
                  label={t("shell.railCollapse")}
                  icon="«"
                  size={28}
                  onClick={() => setRailCollapsed(true)}
                />
              </div>
              {rail}
            </aside>
          )
        ) : null}
        <div className="cb-body-content">{children}</div>
        {hasInspector && !inspectorInSheet ? (
          <aside className="cb-body-inspector">
            {onInspectorClose ? (
              <div className="cb-body-inspector-head">
                <IconButton
                  label={t("shell.inspectorClose")}
                  icon="✕"
                  size={28}
                  onClick={onInspectorClose}
                />
              </div>
            ) : null}
            {inspector}
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
