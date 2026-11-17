import * as RD from "@radix-ui/react-dialog";
import {
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { isSafeAttachmentHref } from "../display/attachments";
import { Icon } from "../icons/icon";
import { useFocusReturn } from "../overlays/focus-return";
import { useDesignT } from "../provider";
import { LoadFailed } from "./file-preview";

export type ImageViewerImage = {
  /** http(s) or a same-origin path; anything else is not loaded. */
  src: string;
  name: string;
  /** Formatted size (the caller formats the attachment's bytes). */
  size?: string;
};

export type ImageViewerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  images: ImageViewerImage[];
  index: number;
  onIndexChange(i: number): void;
  onDownload(i: number): void;
  onOpenInNewTab(i: number): void;
  /**
   * The image failed to load and the caller can reload it (a session refresh, then the same URL
   * with its retry token: a new `src` clears the failure). Absent: the failure stands.
   */
  onRetry?(i: number): void;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const BUTTON_STEP = 1.25;
/** A pointer that moved less than this many px between press and release is a click. */
const CLICK_SLOP = 3;

type Size = { w: number; h: number };
/** `fit` ignores `scale`, `x` and `y`: the image sits centered at its fit scale. */
type View = { fit: boolean; scale: number; x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The image viewer (spec §6.16.20): a full-screen lightbox over a dimmed `lightbox` ground, the
 * image fit to the viewport (never upscaled) and zoomable 10 % to 800 % by wheel (around the
 * pointer), pinch and the toolbar, dragged to pan once it exceeds the viewport, switched with the
 * arrow keys among a message's images. Esc, the close button and a click on the backdrop close it;
 * focus is trapped while open and goes back to the opener. The bars are `raised` strips, not a
 * frame: the image is the page. Built on the dialog primitive for the portal, the focus trap and
 * Esc.
 */
export function ImageViewer({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  onDownload,
  onOpenInNewTab,
  onRetry,
}: ImageViewerProps): JSX.Element {
  const t = useDesignT();
  const focusReturn = useFocusReturn();
  const image = images[index];
  const total = images.length;
  const go = (to: number) => {
    if (to >= 0 && to < total && to !== index) onIndexChange(to);
  };
  /** The body's zoom shortcuts; they ride on the content so they work wherever focus is inside. */
  const keysRef = useRef<((e: KeyboardEvent<HTMLElement>) => void) | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    keysRef.current?.(e);
    if (total < 2 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(index - 1);
    }
  };
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Content
          className="cb-viewer"
          data-part="image-viewer"
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={() => focusReturn.capture()}
          onCloseAutoFocus={focusReturn.restore}
        >
          {image ? (
            // A new image or a new source (the retry token) starts over: fit, no failure.
            <ViewerBody
              key={`${index}:${image.src}`}
              image={image}
              index={index}
              total={total}
              keysRef={keysRef}
              onPrev={() => go(index - 1)}
              onNext={() => go(index + 1)}
              onClose={() => onOpenChange(false)}
              onDownload={() => onDownload(index)}
              onOpenInNewTab={() => onOpenInNewTab(index)}
              {...(onRetry ? { onRetry: () => onRetry(index) } : {})}
            />
          ) : (
            <RD.Title className="cb-viewer-name">{t("files.preview")}</RD.Title>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function ViewerBody({
  keysRef,
  image,
  index,
  total,
  onPrev,
  onNext,
  onClose,
  onDownload,
  onOpenInNewTab,
  onRetry,
}: {
  keysRef: { current: ((e: KeyboardEvent<HTMLElement>) => void) | null };
  image: ImageViewerImage;
  index: number;
  total: number;
  onPrev(): void;
  onNext(): void;
  onClose(): void;
  onDownload(): void;
  onOpenInNewTab(): void;
  onRetry?(): void;
}): JSX.Element {
  const t = useDesignT();
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({ fit: true, scale: 1, x: 0, y: 0 });

  // The area the image fits in: measured at mount and on every resize.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale =
    natural && box && natural.w > 0 && natural.h > 0
      ? Math.min(1, box.w / natural.w, box.h / natural.h)
      : 1;
  const scale = view.fit ? fitScale : view.scale;
  const minScale = Math.min(MIN_SCALE, fitScale);

  /** The pan that keeps the image's edges from leaving an image that exceeds the viewport. */
  const limit = useCallback(
    (x: number, y: number, s: number) => {
      if (!natural || !box) return { x: 0, y: 0 };
      const maxX = Math.max(0, (natural.w * s - box.w) / 2);
      const maxY = Math.max(0, (natural.h * s - box.h) / 2);
      return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
    },
    [natural, box],
  );

  // A resize narrows the room to pan in: keep the pan inside it.
  useEffect(() => {
    setView((v) => {
      if (v.fit) return v;
      const p = limit(v.x, v.y, v.scale);
      return p.x === v.x && p.y === v.y ? v : { ...v, ...p };
    });
  }, [limit]);

  // What the native listeners and the pointer handlers read, so they never go stale.
  const live = useRef({ view, scale, minScale, limit, fitScale });
  live.current = { view, scale, minScale, limit, fitScale };

  /** Zoom to `next`, keeping the point (px, py), in px from the viewport's center, fixed. */
  const zoomTo = useCallback((next: number, px: number, py: number) => {
    const { view: v, scale: cur, minScale: lo, limit: lim } = live.current;
    const s = clamp(next, lo, MAX_SCALE);
    const ratio = s / cur;
    const x0 = v.fit ? 0 : v.x;
    const y0 = v.fit ? 0 : v.y;
    const p = lim(px - (px - x0) * ratio, py - (py - y0) * ratio, s);
    setView({ fit: false, scale: s, x: p.x, y: p.y });
  }, []);

  const centerOf = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  }, []);
  const fit = () => setView({ fit: true, scale: 1, x: 0, y: 0 });
  const actual = () => zoomTo(1, 0, 0);
  const zoomBy = (factor: number) => zoomTo(live.current.scale * factor, 0, 0);

  // The wheel needs a non-passive listener to keep the page from scrolling under the lightbox.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // A trackpad pinch arrives as a ctrl-wheel with small deltas: it zooms faster.
      const rate = e.ctrlKey ? 0.01 : 0.002;
      const c = centerOf();
      zoomTo(
        live.current.scale * Math.exp(-e.deltaY * lines * rate),
        e.clientX - c.x,
        e.clientY - c.y,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, centerOf]);

  // Pointers: one drags (when the image exceeds the viewport), two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinch = useRef<number | null>(null);
  const moved = useRef(false);
  // Whether the press began on the image: with pointer capture the click and dblclick that follow
  // are retargeted to the stage, so the press, not the click target, says what was hit.
  const downOnItem = useRef(false);
  const exceeds = () => {
    const { scale: s } = live.current;
    return !!natural && !!box && (natural.w * s > box.w || natural.h * s > box.h);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    if (pointers.current.size === 0)
      downOnItem.current = !!(e.target as Element).closest?.("[data-viewer-item]");
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 1) {
      moved.current = false;
      const { view: v } = live.current;
      drag.current = { x: e.clientX, y: e.clientY, px: v.fit ? 0 : v.x, py: v.fit ? 0 : v.y };
    } else if (pointers.current.size === 2) {
      drag.current = null;
      moved.current = true;
      const [a, b] = [...pointers.current.values()];
      pinch.current = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d === 0) return;
      const c = centerOf();
      zoomTo(
        live.current.scale * (d / pinch.current),
        (a.x + b.x) / 2 - c.x,
        (a.y + b.y) / 2 - c.y,
      );
      pinch.current = d;
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > CLICK_SLOP) moved.current = true;
    if (!exceeds()) return;
    const { scale: s, limit: lim } = live.current;
    const p = lim(d.px + dx, d.py + dy, s);
    setView({ fit: false, scale: s, x: p.x, y: p.y });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  // A click on the backdrop closes; the image, the failure card and the end of a drag do not.
  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (downOnItem.current || (e.target as Element).closest("[data-viewer-item]")) return;
    onClose();
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!downOnItem.current) return;
    const { view: v, scale: s } = live.current;
    if (v.fit && Math.abs(s - 1) < 0.005) return;
    if (v.fit) {
      const c = centerOf();
      zoomTo(1, e.clientX - c.x, e.clientY - c.y);
    } else fit();
  };

  // + - 0 (fit) 1 (100 %) from the keyboard, beside the arrows the shell handles.
  const onKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(BUTTON_STEP);
    else if (e.key === "-") zoomBy(1 / BUTTON_STEP);
    else if (e.key === "0") fit();
    else if (e.key === "1") actual();
  };

  // A stable handler that reads the latest onKeys. Clear the ref only if it still holds this body's
  // own handler: when the image changes, the new body has already installed its own.
  const latestKeys = useRef(onKeys);
  latestKeys.current = onKeys;
  const ownKeys = useCallback((e: KeyboardEvent<HTMLElement>) => latestKeys.current(e), []);
  keysRef.current = ownKeys;
  useEffect(
    () => () => {
      if (keysRef.current === ownKeys) keysRef.current = null;
    },
    [keysRef, ownKeys],
  );
  const safe = isSafeAttachmentHref(image.src);
  const canPan = exceeds();
  return (
    <div className="cb-viewer-root">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer gestures on the image area; the keyboard has Esc, the arrows and + - 0 1 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Esc is its keyboard form */}
      <div
        className="cb-viewer-stage"
        data-part="image-viewer-stage"
        data-pannable={canPan ? "true" : undefined}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        <div className="cb-viewer-box" ref={boxRef}>
          {failed ? (
            <div className="cb-viewer-failed" data-viewer-item>
              <LoadFailed name={image.name} {...(onRetry ? { onRetry } : {})} />
            </div>
          ) : safe ? (
            <img
              className="cb-viewer-img"
              data-viewer-item
              data-sized={natural ? "true" : undefined}
              src={image.src}
              alt={image.name}
              referrerPolicy="no-referrer"
              draggable={false}
              style={
                natural
                  ? {
                      width: natural.w,
                      height: natural.h,
                      transform: `translate(${view.fit ? 0 : view.x}px, ${view.fit ? 0 : view.y}px) scale(${scale})`,
                    }
                  : undefined
              }
              onLoad={(e) =>
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onError={() => setFailed(true)}
            />
          ) : null}
        </div>
      </div>
      <div className="cb-viewer-top" data-part="image-viewer-top">
        <div className="cb-viewer-bar">
          <RD.Title className="cb-viewer-name" title={image.name}>
            {image.name}
          </RD.Title>
          {image.size !== undefined ? <span className="cb-muted">{image.size}</span> : null}
          {total > 1 ? (
            <span className="cb-muted" data-part="image-viewer-count">
              {index + 1} / {total}
            </span>
          ) : null}
        </div>
        <div className="cb-viewer-bar">
          <IconButton
            label={t("viewer.openInNewTab")}
            icon={<Icon name="external-link" size={14} />}
            density="dense"
            onClick={onOpenInNewTab}
          />
          <IconButton
            label={t("files.download")}
            icon={<Icon name="download" size={14} />}
            density="dense"
            onClick={onDownload}
          />
          <IconButton
            label={t("overlay.close")}
            icon={<Icon name="x" size={14} />}
            density="dense"
            onClick={onClose}
          />
        </div>
      </div>
      {total > 1 ? (
        <>
          <div className="cb-viewer-side" data-side="prev">
            <IconButton
              label={t("viewer.prev")}
              icon={<Icon name="chevron-left" size={16} />}
              disabled={index === 0}
              onClick={onPrev}
            />
          </div>
          <div className="cb-viewer-side" data-side="next">
            <IconButton
              label={t("viewer.next")}
              icon={<Icon name="chevron-right" size={16} />}
              disabled={index === total - 1}
              onClick={onNext}
            />
          </div>
        </>
      ) : null}
      <div className="cb-viewer-bottom">
        <div className="cb-viewer-bar" data-part="image-viewer-tools">
          <IconButton
            label={t("viewer.zoomOut")}
            icon={<Icon name="zoom-out" size={14} />}
            density="dense"
            onClick={() => zoomBy(1 / BUTTON_STEP)}
          />
          <span className="cb-viewer-percent" data-part="image-viewer-percent" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <IconButton
            label={t("viewer.zoomIn")}
            icon={<Icon name="zoom-in" size={14} />}
            density="dense"
            onClick={() => zoomBy(BUTTON_STEP)}
          />
          <IconButton
            label={t("viewer.actualSize")}
            icon={<span className="cb-viewer-one">1:1</span>}
            density="dense"
            onClick={actual}
          />
          <IconButton
            label={t("viewer.fit")}
            icon={<Icon name="maximize-2" size={14} />}
            density="dense"
            onClick={fit}
          />
        </div>
      </div>
    </div>
  );
}
