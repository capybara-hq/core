import * as RD from "@radix-ui/react-dialog";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { NewTitleBar, TitleBar, type TitleBarProps } from "../conversation/title-bar";
import { useFocusReturn } from "../overlays/focus-return";
import { useDesignT } from "../provider";
import { StatusBar } from "../shell/status-bar";
import { useMediaQuery } from "../shell/use-media-query";
import { useFollowBottom } from "./follow-bottom";

// The conversation page (T7, design spec §5.4): the middle column (title bar, thread, composer,
// status bar) and one right area: the properties panel inside the middle column, or one right
// panel beside it, full height and resizable. Below a 1280 window the right area is a sheet.

/** `layout.panel-min`, `layout.panel`, `layout.chat-min` (tokens.json). */
export const PANEL_MIN = 520;
export const PANEL_DEFAULT = 560;
export const CHAT_MIN = 480;
/** One arrow-key step of the resize handle. */
export const PANEL_STEP = 16;
/** The per-viewer panel width (spec §6.16.18). */
export const PANEL_WIDTH_KEY = "cap.chat.panelWidth";

/** The panel width clamped to [`layout.panel-min`, content − `layout.chat-min`]. */
export function clampPanelWidth(width: number, contentWidth: number): number {
  const max =
    contentWidth > 0 ? Math.max(PANEL_MIN, contentWidth - CHAT_MIN) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

function readWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_WIDTH_KEY);
    const n = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

function writeWidth(n: number) {
  try {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(n));
  } catch {
    // Storage may be blocked (private windows); the width then lasts for this page only.
  }
}

export type ConversationStatus = {
  /** `user@org:/chat/<id>`. */
  context: string;
  /** "第 N 轮 · 已用 <elapsed>"; none on a new conversation. */
  stats?: string;
  /** Run status and "上下文 N%", before the version; none on a new conversation. */
  right?: string[];
  version: string;
};

export type ConversationPageProps = {
  titleBar: TitleBarProps;
  /** A new conversation (nothing created yet): the agent's name and description over the composer. */
  newConversation?: { agentName: string; description?: string };
  /** The thread; it follows the bottom while the reader is at the bottom. */
  thread?: ReactNode;
  composer: ReactNode;
  status: ConversationStatus;
  /** Shown when `right` is "properties". */
  properties?: ReactNode;
  /** Shown when `right` is "panel". */
  panel?: ReactNode;
  right: "none" | "properties" | "panel";
  onCloseRight(): void;
  /**
   * The right area as a sheet ("sheet") or beside the thread ("inline"); "auto" (default) follows
   * the window: a sheet below 1280.
   */
  layout?: "auto" | "sheet" | "inline";
  /** The reference set only: the sheet drawn in its positioned box, not over the window. */
  reference?: boolean;
};

export function ConversationPage({
  titleBar,
  newConversation,
  thread,
  composer,
  status,
  properties,
  panel,
  right,
  onCloseRight,
  layout = "auto",
  reference,
}: ConversationPageProps) {
  const t = useDesignT();
  const narrowWindow = useMediaQuery("(max-width: 1279px)");
  const sheet = layout === "sheet" || (layout === "auto" && narrowWindow);
  const scroll = useFollowBottom<HTMLDivElement>();
  const root = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState(0);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const focusReturn = useFocusReturn();

  useEffect(() => setWidth(readWidth()), []);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => {
      const w = e[0]?.contentRect.width;
      if (w !== undefined) setContent(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = clampPanelWidth(width, content);
  const resize = useCallback(
    (next: number) => {
      const w = clampPanelWidth(next, content);
      setWidth(w);
      writeWidth(w);
    },
    [content],
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The handle sits on the panel's left edge: ← widens the panel, → narrows it.
    if (e.key === "ArrowLeft") resize(shown + PANEL_STEP);
    else if (e.key === "ArrowRight") resize(shown - PANEL_STEP);
    else if (e.key === "Home") resize(PANEL_MIN);
    else if (e.key === "End") resize(Number.POSITIVE_INFINITY);
    else return;
    e.preventDefault();
  };
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: shown };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) resize(d.w + (d.x - e.clientX));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const center = newConversation ? (
    <div className="cb-conv-center">
      <div className="cb-conv-scroll" data-center="true">
        <div className="cb-conv-new" data-part="new-conversation-body">
          <h2 className="cb-conv-new-name">{newConversation.agentName}</h2>
          {newConversation.description ? (
            <p className="cb-conv-new-desc">{newConversation.description}</p>
          ) : null}
          {composer}
        </div>
      </div>
    </div>
  ) : (
    <div className="cb-conv-center">
      <div ref={scroll} className="cb-conv-scroll">
        <div className="cb-conv-thread" data-part="thread">
          {thread}
        </div>
      </div>
      <div className="cb-conv-composer">{composer}</div>
    </div>
  );

  const rightNode = right === "properties" ? properties : right === "panel" ? panel : null;
  const open = rightNode != null && right !== "none";

  return (
    <div
      ref={root}
      className="cb-template cb-conv-page"
      data-template="ConversationPage"
      data-right={right}
      data-sheet={sheet ? "true" : undefined}
    >
      <div className="cb-conv-main" data-part="conv-main">
        {newConversation ? <NewTitleBar /> : <TitleBar {...titleBar} />}
        <div className="cb-conv-cols">
          {center}
          {!sheet && right === "properties" ? properties : null}
        </div>
        <StatusBar
          context={status.context}
          version={status.version}
          pageStatus={status.stats}
          system={status.right}
          announceFirst={(status.right?.length ?? 0) > 0}
        />
      </div>
      {!sheet && right === "panel" && open ? (
        <div
          className="cb-conv-panel"
          data-part="panel-slot"
          style={{ "--cb-conv-panel-w": `${shown}px` } as CSSProperties}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable splitter, not an <hr> */}
          <div
            className="cb-conv-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("panel.resize")}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={content > 0 ? Math.max(PANEL_MIN, content - CHAT_MIN) : undefined}
            aria-valuenow={shown}
            tabIndex={0}
            data-dragging={dragging ? "true" : undefined}
            onKeyDown={onKey}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {panel}
        </div>
      ) : null}
      {sheet ? (
        // Kept mounted in sheet mode so closing runs Radix's close path (focus goes back to the
        // title-bar icon that opened it).
        <RD.Root
          open={open}
          modal={!reference}
          onOpenChange={(o) => {
            if (!o) onCloseRight();
          }}
        >
          {!open ? null : reference ? (
            <>
              <div className="cb-conv-scrim" data-inline="true" data-part="scrim" />
              <SheetContent inline label={t("panel.label")} focusReturn={focusReturn}>
                {rightNode}
              </SheetContent>
            </>
          ) : (
            <RD.Portal>
              <RD.Overlay className="cb-conv-scrim" data-part="scrim" />
              <SheetContent label={t("panel.label")} focusReturn={focusReturn}>
                {rightNode}
              </SheetContent>
            </RD.Portal>
          )}
        </RD.Root>
      ) : null}
    </div>
  );
}

function SheetContent({
  inline,
  label,
  focusReturn,
  children,
}: {
  inline?: boolean;
  label: string;
  focusReturn: ReturnType<typeof useFocusReturn>;
  children?: ReactNode;
}) {
  return (
    <RD.Content
      className="cb-conv-sheet"
      data-part="sheet"
      data-inline={inline ? "true" : undefined}
      aria-describedby={undefined}
      // Drawn in place for the reference set: never steal focus or close on outside clicks.
      {...(inline
        ? {
            onOpenAutoFocus: (e: Event) => e.preventDefault(),
            onInteractOutside: (e: Event) => e.preventDefault(),
          }
        : { onOpenAutoFocus: focusReturn.capture, onCloseAutoFocus: focusReturn.restore })}
    >
      <RD.Title className="cb-sr-only">{label}</RD.Title>
      {children}
    </RD.Content>
  );
}
