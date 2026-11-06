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

type ToastAction = { label: string; run(): void } | undefined;

type ToastItem =
  | { id: number; kind: "success"; msg: string; action?: ToastAction }
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
const TOAST_ICON = {
  success: "circle-check",
  error: "circle-alert",
  progress: "spinner",
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useDesignT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const h of set) clearTimeout(h);
      set.clear();
    };
  }, []);

  const close = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);

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
          },
        ]);
        const h = setTimeout(
          () => {
            timers.current.delete(h);
            close(id);
          },
          opts ? UNDO_MS : SUCCESS_MS,
        );
        timers.current.add(h);
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

  const renderToast = (it: ToastItem) => (
    <div
      key={it.id}
      className="cb-toast"
      data-kind={it.kind}
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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* 两个分组：错误以 role=alert 自行播报，不能再嵌在 aria-live 区域里（否则读两遍）。 */}
      <div className="cb-toast-region">
        <div className="cb-toast-group" data-group="alert">
          {items.filter((it) => it.kind === "error").map(renderToast)}
        </div>
        <div className="cb-toast-group" data-group="status" role="status" aria-live="polite">
          {items.filter((it) => it.kind !== "error").map(renderToast)}
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
