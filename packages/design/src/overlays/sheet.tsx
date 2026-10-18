import * as RD from "@radix-ui/react-dialog";
import { type ReactNode, useState } from "react";
import { Button, IconButton } from "../controls/index.js";
import { useDesignT } from "../provider.js";
import { Dialog } from "./dialog.js";

export type SheetProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  meta?: ReactNode;
  width?: 480 | 720;
  openHref?: string;
  tabs?: ReactNode;
  footer?: ReactNode;
  dirty?: boolean;
  children?: ReactNode;
};

export function Sheet({
  open,
  onOpenChange,
  title,
  meta,
  width = 480,
  openHref,
  tabs,
  footer,
  dirty,
  children,
}: SheetProps) {
  const t = useDesignT();
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirming(true);
    else onOpenChange(false);
  };
  return (
    <>
      <RD.Root
        open={open}
        modal={false}
        onOpenChange={(o) => {
          if (o) onOpenChange(true);
          else requestClose();
        }}
      >
        <RD.Portal>
          <RD.Content
            className="cb-sheet"
            data-width={width}
            aria-describedby={undefined}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <div className="cb-sheet-head">
              <RD.Title className="cb-sheet-title">{title}</RD.Title>
              {meta ? <span className="cb-sheet-meta">{meta}</span> : null}
              <span className="cb-sheet-actions">
                {openHref ? (
                  <a
                    className="cb-btn cb-icon-btn"
                    data-variant="ghost"
                    data-size="24"
                    href={openHref}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("overlay.openInNew")}
                    title={t("overlay.openInNew")}
                  >
                    ↗
                  </a>
                ) : null}
                <IconButton label={t("overlay.close")} icon="✕" size={24} onClick={requestClose} />
              </span>
            </div>
            {tabs ? <div className="cb-sheet-tabs">{tabs}</div> : null}
            <div className="cb-sheet-body">{children}</div>
            {footer ? <div className="cb-sheet-foot">{footer}</div> : null}
          </RD.Content>
        </RD.Portal>
      </RD.Root>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.discardTitle")}
        initialFocus="cancel"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("overlay.keepEditing")}
            </Button>
            <Button
              variant="danger-solid"
              onClick={() => {
                setConfirming(false);
                onOpenChange(false);
              }}
            >
              {t("overlay.discard")}
            </Button>
          </>
        }
      />
    </>
  );
}
