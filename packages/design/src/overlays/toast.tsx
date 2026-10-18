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
import { useDesignT } from "../provider";

type ToastItem =
  | { id: number; kind: "success"; msg: string }
  | { id: number; kind: "error"; msg: string; action?: { label: string; run(): void } | undefined }
  | { id: number; kind: "progress"; msg: string; done: number; total: number };

export type ToastApi = {
  success(msg: string): void;
  error(msg: string, opts?: { actionLabel: string; onAction(): void }): void;
  progress(
    msg: string,
    p: { done: number; total: number },
  ): { update(done: number): void; close(): void };
};

const ToastContext = createContext<ToastApi | null>(null);

const SUCCESS_MS = 4000;
const SEGMENTS = 10;

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
      success(msg) {
        const id = nextId.current++;
        setItems((l) => [...l, { id, kind: "success", msg }]);
        const h = setTimeout(() => {
          timers.current.delete(h);
          close(id);
        }, SUCCESS_MS);
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

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="cb-toast-region" role="status" aria-live="polite">
        {items.map((it) => (
          <div
            key={it.id}
            className="cb-toast"
            data-kind={it.kind}
            role={it.kind === "error" ? "alert" : undefined}
          >
            <span className="cb-toast-msg">{it.msg}</span>
            {it.kind === "error" && it.action ? (
              <button
                type="button"
                className="cb-toast-action"
                onClick={() => {
                  it.action?.run();
                  close(it.id);
                }}
              >
                {it.action.label} →
              </button>
            ) : null}
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
            <IconButton
              label={t("overlay.close")}
              icon="✕"
              size={24}
              onClick={() => close(it.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
