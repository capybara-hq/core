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
import { PropertiesPanel, PropertySection, RightPanel } from "../conversation/panels";
import { NewTitleBar, TitleBar, type TitleBarProps } from "../conversation/title-bar";
import { WorkingLine } from "../conversation/working-line";
import { SkeletonGroup, SkeletonText } from "../display/skeleton";
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
  /** `<login>@<org slug>:~/chat/<id>` (spec §4.4). */
  context: string;
  /**
   * "第 N 轮 · 已用 <elapsed>"; none on a new conversation. A node, so a page can tick the elapsed
   * time in a small component instead of re-rendering itself each second.
   */
  stats?: ReactNode;
  /** Run status and "上下文 N%", before the version; none on a new conversation. */
  right?: string[];
  /** The run status's colour (the first `right` item): `fail` after a failed run. */
  tone?: "fail";
  version: string;
  /** The viewer's time zone (`UTC+8`), after the version, as on every page (spec §4.4). */
  timeZone?: string;
};

export type ConversationPageProps = {
  titleBar: TitleBarProps;
  /** A new conversation (nothing created yet): the agent's name and description over the composer. */
  newConversation?: { agentName: string; description?: string };
  /** The thread; it follows the bottom while the reader is at the bottom. */
  thread?: ReactNode;
  /**
   * The working line (§6.16.24) after the thread, where the run's first output will appear. The
   * page decides when (from the log and its pending messages); at most one per conversation.
   */
  working?: boolean;
  /** The queued messages (§6.16.14), after the thread and the working line. */
  queue?: ReactNode;
  /**
   * The composer. A function receives `{ sendDisabled }`, true while the thread loads: the
   * composer stays mounted and editable, and only sending is blocked (pass it to the composer's
   * `send.disabled`).
   */
  composer: ReactNode | ((state: { sendDisabled: boolean }) => ReactNode);
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
  /**
   * Parts whose data is on the way (spec §5.4, §7.1). `thread`: three placeholder turns in the
   * thread column; the composer stays real and editable, only sending is blocked (see `composer`).
   * `title`: a bar in the title's place (the path and every icon stay real). `rightArea` (`true`,
   * or `{ title }`, the open panel's title): the open right area draws its own loading state (the
   * right panel's `loading`, or one loading Context section) instead of `panel` / `properties`; a closed area stays closed. One announcement
   * for all of it.
   */
  loading?: { thread?: boolean; title?: boolean; rightArea?: boolean | { title?: string } };
  /** The reference set only: the sheet drawn in its positioned box, not over the window. */
  reference?: boolean;
};

/** The thread's placeholder turns (spec §5.4): a user bubble, then a prose block of two lines. */
function LoadingThread() {
  return (
    <>
      <div className="cb-user-msg" data-part="loading-turn">
        <div className="cb-bubble-slot" data-part="loading-bubble">
          <SkeletonText width="100%" size="prose" />
        </div>
      </div>
      <div data-part="loading-turn">
        <SkeletonText width="100%" size="prose" />
      </div>
      <div data-part="loading-turn">
        <SkeletonText width="70%" size="prose" />
      </div>
    </>
  );
}

/**
 * Focus for the inline right area (m11; the sheet has Radix's): when it opens or changes (Back
 * to the properties panel), the new area takes focus unless focus is already inside it, and when
 * it closes focus returns to what opened it, so × and Back never drop focus to the page.
 */
function useInlineFocus(
  root: { readonly current: HTMLElement | null },
  shown: "none" | "sheet" | "properties" | "panel",
): void {
  const opener = useRef<HTMLElement | null>(null);
  const last = useRef(shown);
  useEffect(() => {
    if (last.current === shown) return;
    last.current = shown;
    if (shown === "sheet") {
      opener.current = null;
      return;
    }
    if (shown === "none") {
      const el = opener.current;
      opener.current = null;
      // only when focus was lost with the area (not when the person moved it elsewhere)
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (el?.isConnected && lost) el.focus();
      return;
    }
    const active = document.activeElement;
    if (opener.current === null && active instanceof HTMLElement && active !== document.body) {
      opener.current = active;
    }
    const area = root.current?.querySelector<HTMLElement>(
      shown === "panel" ? '[data-part="panel-slot"] > aside' : '[data-part="properties"]',
    );
    if (area && !area.contains(document.activeElement)) area.focus({ preventScroll: true });
  }, [root, shown]);
}

export function ConversationPage({
  titleBar,
  newConversation,
  thread,
  working,
  queue,
  composer,
  status,
  properties,
  panel,
  right,
  onCloseRight,
  layout = "auto",
  loading,
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

  const composerNode =
    typeof composer === "function"
      ? composer({ sendDisabled: loading?.thread === true })
      : composer;
  const center = newConversation ? (
    <div className="cb-conv-center">
      <div className="cb-conv-scroll" data-center="true">
        <div className="cb-conv-new" data-part="new-conversation-body">
          <h2 className="cb-conv-new-name">{newConversation.agentName}</h2>
          {newConversation.description ? (
            <p className="cb-conv-new-desc">{newConversation.description}</p>
          ) : null}
          {composerNode}
        </div>
      </div>
    </div>
  ) : (
    <div className="cb-conv-center">
      <div ref={scroll} className="cb-conv-scroll">
        <div className="cb-conv-thread" data-part="thread">
          {loading?.thread ? (
            <LoadingThread />
          ) : (
            <>
              {thread}
              {/* kept mounted (its live region) once the page uses it */}
              {working !== undefined ? <WorkingLine active={working} /> : null}
              {queue}
            </>
          )}
        </div>
      </div>
      <div className="cb-conv-composer">{composerNode}</div>
    </div>
  );

  const loadingRight = loading?.rightArea !== undefined && loading.rightArea !== false;
  const rightTitle =
    typeof loading?.rightArea === "object" && loading.rightArea.title !== undefined
      ? loading.rightArea.title
      : t("panel.label");
  const propertiesNode = loadingRight ? (
    <PropertiesPanel>
      <PropertySection title={t("props.context")} state="loading" />
    </PropertiesPanel>
  ) : (
    properties
  );
  const panelNode = loadingRight ? (
    <RightPanel title={rightTitle} state="loading" onClose={onCloseRight} />
  ) : (
    panel
  );
  const rightNode = right === "properties" ? propertiesNode : right === "panel" ? panelNode : null;
  const anyLoading = loading?.thread === true || loading?.title === true || loadingRight;
  const open = rightNode != null && right !== "none";
  useInlineFocus(root, sheet ? "sheet" : open ? right : "none");

  return (
    <div
      ref={root}
      className="cb-template cb-conv-page"
      data-template="ConversationPage"
      data-right={right}
      data-layout={layout}
      data-sheet={sheet ? "true" : undefined}
    >
      <SkeletonGroup label={t("table.loading")} active={anyLoading}>
        <div className="cb-conv-main" data-part="conv-main">
          {newConversation ? (
            <NewTitleBar />
          ) : (
            <TitleBar {...titleBar} {...(loading?.title ? { loading: true } : {})} />
          )}
          <div className="cb-conv-cols">
            {center}
            {!sheet && right === "properties" ? propertiesNode : null}
          </div>
          <StatusBar
            context={status.context}
            version={status.version}
            {...(status.timeZone !== undefined ? { timeZone: status.timeZone } : {})}
            pageStatus={status.stats}
            system={status.right}
            {...(status.tone !== undefined ? { systemTone: status.tone } : {})}
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
            {panelNode}
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
      </SkeletonGroup>
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
