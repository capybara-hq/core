import * as RD from "@radix-ui/react-dialog";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button, IconButton } from "../controls/index.js";
import { Input } from "../controls/inputs.js";
import { useDesignT } from "../provider.js";

export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  size?: 480 | 640;
  footer: ReactNode;
  initialFocus?: "primary" | "cancel" | undefined;
  danger?: boolean;
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
  children,
}: DialogProps) {
  const t = useDesignT();
  const footerRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          className="cb-dialog"
          data-size={size}
          data-danger={danger ? "true" : undefined}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // 触发按钮常在 Dialog 之外受控打开，Radix 不认识它，所以自己归还焦点。
            const el = returnTo.current;
            returnTo.current = null;
            if (el?.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          onOpenAutoFocus={(e) => {
            returnTo.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
              <IconButton label={t("overlay.close")} icon="✕" size={24} />
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
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matched = typed === confirmName;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
      title={title}
      danger
      initialFocus="cancel"
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
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="cb-dialog-desc">{description}</div>
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
    </Dialog>
  );
}
