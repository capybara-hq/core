import * as RD from "@radix-ui/react-dialog";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, IconButton } from "../controls/index";
import { Input } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { useFocusReturn } from "./focus-return";

export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  size?: 480 | 640;
  footer: ReactNode;
  initialFocus?: "primary" | "cancel" | undefined;
  danger?: boolean;
  /** 描述正文的元素 id，作为对话框的 aria-describedby。 */
  describedBy?: string | undefined;
  children?: ReactNode;
};

export function Dialog({
  open,
  onOpenChange,
  title,
  size = 480,
  footer,
  initialFocus = "primary",
  danger,
  describedBy,
  children,
}: DialogProps) {
  const t = useDesignT();
  const footerRef = useRef<HTMLDivElement>(null);
  const focusReturn = useFocusReturn();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          className="cb-dialog"
          data-size={size}
          data-danger={danger ? "true" : undefined}
          aria-describedby={describedBy}
          onCloseAutoFocus={focusReturn.restore}
          onOpenAutoFocus={(e) => {
            focusReturn.capture();
            const buttons = Array.from(
              footerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
            );
            const target =
              initialFocus === "cancel"
                ? buttons[0]
                : (buttons.find((b) =>
                    ["primary", "danger-solid"].includes(b.getAttribute("data-variant") ?? ""),
                  ) ?? buttons[buttons.length - 1]);
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="cb-dialog-head">
            <RD.Title className="cb-dialog-title">{title}</RD.Title>
            <RD.Close asChild>
              <IconButton
                label={t("overlay.close")}
                icon={<Icon name="x" size={14} />}
                density="dense"
              />
            </RD.Close>
          </div>
          <div className="cb-dialog-body">{children}</div>
          <div className="cb-dialog-foot" ref={footerRef}>
            {footer}
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export type DangerConfirmProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirmName: string;
  confirmLabel: string;
  onConfirm(): void | Promise<void>;
};

export function DangerConfirm({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  onConfirm,
}: DangerConfirmProps) {
  const t = useDesignT();
  const inputId = useId();
  const descId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每次开 / 关递增：关闭后才结束的 onConfirm 不再改动下一次打开的状态
  const session = useRef(0);
  useEffect(() => {
    session.current += 1;
    if (open) return;
    setTyped("");
    setBusy(false);
    setError(null);
  }, [open]);
  const matched = typed === confirmName;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      danger
      initialFocus="cancel"
      describedBy={descId}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("overlay.cancel")}
          </Button>
          <Button
            variant={matched ? "danger-solid" : "danger"}
            disabled={!matched}
            loading={busy}
            onClick={async () => {
              const current = session.current;
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err) {
                // 失败时保持对话框打开，在正文下方显示原因，用户可重试或取消
                if (session.current === current) {
                  setError(
                    err instanceof Error && err.message ? err.message : t("overlay.actionFailed"),
                  );
                }
              } finally {
                if (session.current === current) setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="cb-dialog-desc" id={descId}>
        {description}
      </div>
      <div className="cb-dialog-confirm">
        <label htmlFor={inputId}>
          {t("overlay.typeToConfirm")} <code>{confirmName}</code>
        </label>
        <Input
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </div>
      {error ? (
        <div className="cb-dialog-error" role="alert">
          <Icon name="circle-x" size={14} />
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
