import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { useClassForm } from "../shell/class-forms";

type ToastAction = { label: string; run(): void } | undefined;

type ToastItem =
  /** `ms`: how long it stays once shown (its timer starts only then). */
  | { id: number; kind: "success"; msg: string; action?: ToastAction; ms: number }
  | { id: number; kind: "error"; msg: string; action?: ToastAction }
  | { id: number; kind: "progress"; msg: string; done: number; total: number };

export type ToastApi = {
  /** A result; with an action (Undo of a Repeater's remove) it stays {@link UNDO_MS}, else 4 s. */
  success(msg: string, opts?: { actionLabel: string; onAction(): void }): void;
  error(msg: string, opts?: { actionLabel: string; onAction(): void }): void;
  progress(
    msg: string,
    p: { done: number; total: number },
  ): { update(done: number): void; close(): void };
};

const ToastContext = createContext<ToastApi | null>(null);

const SUCCESS_MS = 4000;
/** How long a success toast carrying an action (Undo) stays (spec §6.7). */
const UNDO_MS = 8000;
const SEGMENTS = 10;
/** A touch drag down by this many px dismisses a toast (spec §7). */
const SWIPE_DISMISS_PX = 40;
const TOAST_ICON = {
  success: "circle-check",
  error: "circle-alert",
  progress: "spinner",
} as const;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useDesignT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  // one auto-dismiss timer per shown success toast, keyed by its id
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const form = useClassForm();

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const h of map.values()) clearTimeout(h);
      map.clear();
    };
  }, []);

  const close = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);

  // On compact one toast shows at a time (interaction spec §7, D2): the oldest error, else the
  // oldest other toast, first in first shown; the rest wait (`data-queued`, hidden by CSS there).
  const shownOnCompact = (items.find((x) => x.kind === "error") ?? items[0])?.id;
  const visible = useCallback(
    (id: number) => form !== "compact" || id === shownOnCompact,
    [form, shownOnCompact],
  );
  // A timer runs only while its toast is visible, so a queued toast never expires unseen: from
  // 600 every toast is visible as it arrives, below 600 only the shown one. A toast pushed back
  // into the queue (an error arrived) drops its timer and gets its full duration when shown again.
  useEffect(() => {
    const map = timers.current;
    for (const [id, h] of map) {
      if (!items.some((x) => x.id === id) || !visible(id)) {
        clearTimeout(h);
        map.delete(id);
      }
    }
    for (const it of items) {
      if (it.kind !== "success" || map.has(it.id) || !visible(it.id)) continue;
      const h = setTimeout(() => {
        map.delete(it.id);
        close(it.id);
      }, it.ms);
      map.set(it.id, h);
    }
  }, [items, visible, close]);

  const api = useMemo<ToastApi>(
    () => ({
      success(msg, opts) {
        const id = nextId.current++;
        setItems((l) => [
          ...l,
          {
            id,
            kind: "success",
            msg,
            action: opts ? { label: opts.actionLabel, run: opts.onAction } : undefined,
            ms: opts ? UNDO_MS : SUCCESS_MS,
          },
        ]);
      },
      error(msg, opts) {
        const id = nextId.current++;
        setItems((l) => [
          ...l,
          {
            id,
            kind: "error",
            msg,
            action: opts ? { label: opts.actionLabel, run: opts.onAction } : undefined,
          },
        ]);
      },
      progress(msg, p) {
        const id = nextId.current++;
        setItems((l) => [...l, { id, kind: "progress", msg, ...p }]);
        return {
          update: (done) =>
            setItems((l) =>
              l.map((x) => (x.id === id && x.kind === "progress" ? { ...x, done } : x)),
            ),
          close: () => close(id),
        };
      },
    }),
    [close],
  );

  const swipeStart = useRef<number | null>(null);

  const renderToast = (it: ToastItem) => (
    <div
      key={it.id}
      className="cb-toast"
      onPointerDown={(e) => {
        // A drag that starts on the action or the close button is a press, not a swipe.
        const onButton = (e.target as HTMLElement).closest("button") !== null;
        swipeStart.current = e.pointerType === "touch" && !onButton ? e.clientY : null;
      }}
      onPointerMove={(e) => {
        const from = swipeStart.current;
        if (from === null || prefersReducedMotion()) return;
        e.currentTarget.style.transform = `translateY(${Math.max(0, e.clientY - from)}px)`;
      }}
      onPointerUp={(e) => {
        const from = swipeStart.current;
        swipeStart.current = null;
        e.currentTarget.style.transform = "";
        if (from !== null && e.clientY - from >= SWIPE_DISMISS_PX) close(it.id);
      }}
      onPointerCancel={(e) => {
        swipeStart.current = null;
        e.currentTarget.style.transform = "";
      }}
      data-kind={it.kind}
      data-queued={visible(it.id) ? undefined : "true"}
      role={it.kind === "error" ? "alert" : undefined}
    >
      {/* Three-column grid: the status icon, then the head row and the progress bar (so the bar is
          as wide as the head), then the close button. The icon carries the status, not color alone:
          ok circle-check, fail circle-alert, progress spinner. */}
      <span className="cb-toast-icon">
        <Icon name={TOAST_ICON[it.kind]} size={16} />
      </span>
      <div className="cb-toast-head">
        <span className="cb-toast-msg">{it.msg}</span>
        {it.kind === "progress" ? (
          <span className="cb-toast-count">{`${it.done}/${it.total}`}</span>
        ) : null}
        {it.kind !== "progress" && it.action ? (
          <button
            type="button"
            className="cb-toast-action"
            onClick={() => {
              it.action?.run();
              close(it.id);
            }}
          >
            {/* An error's action leads somewhere ("View →"); a success's undoes (no arrow). */}
            {it.kind === "error" ? `${it.action.label} →` : it.action.label}
          </button>
        ) : null}
      </div>
      <span className="cb-toast-close">
        <IconButton
          label={t("overlay.close")}
          icon={<Icon name="x" size={14} />}
          density="dense"
          onClick={() => close(it.id)}
        />
      </span>
      {it.kind === "progress" ? (
        <div
          className="cb-toast-bar"
          role="progressbar"
          aria-label={t("toast.progress")}
          aria-valuemin={0}
          aria-valuemax={it.total}
          aria-valuenow={it.done}
        >
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定段数
              key={i}
              data-on={i < Math.round((it.done / it.total) * SEGMENTS) ? "true" : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  const newestFirst = [...items].reverse();

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Two groups: errors announce themselves with role=alert and must not sit inside the
          aria-live region (else they are read twice). Each group lists the newest first, so the
          stack grows downward from the top with the newest on top (spec §6.7). */}
      <div className="cb-toast-region">
        <div className="cb-toast-group" data-group="alert">
          {newestFirst.filter((it) => it.kind === "error").map(renderToast)}
        </div>
        <div className="cb-toast-group" data-group="status" role="status" aria-live="polite">
          {newestFirst.filter((it) => it.kind !== "error").map(renderToast)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

/** The toast API, or null outside a `ToastProvider` (a component that toasts only as a bonus). */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
