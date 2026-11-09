import * as RD from "@radix-ui/react-dialog";
import { type ReactNode, useState } from "react";
import { Button, IconButton } from "../controls/index";
import { ObjectMark } from "../display/object-mark";
import { Icon } from "../icons/icon";
import { BoxScope } from "../layout/box";
import { useDesignLink, useDesignT } from "../provider";
import { Dialog } from "./dialog";
import { useFocusReturn } from "./focus-return";

export type SheetProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /**
   * A 28 px mark before the title, for a thing a plugin brings (an extension): the plugin's
   * declared icon (`image`), else the initial of `text` (spec §6.17).
   */
  mark?: { text: string; image?: string | null };
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
  mark,
  meta,
  width = 480,
  openHref,
  tabs,
  footer,
  dirty,
  children,
}: SheetProps) {
  const t = useDesignT();
  const Link = useDesignLink();
  const focusReturn = useFocusReturn();
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
            data-cap-part="dialog"
            data-width={width}
            aria-describedby={undefined}
            onOpenAutoFocus={focusReturn.capture}
            onCloseAutoFocus={focusReturn.restore}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <div className="cb-sheet-head">
              {mark ? <ObjectMark text={mark.text} image={mark.image ?? null} size={28} /> : null}
              <RD.Title className="cb-sheet-title">{title}</RD.Title>
              {meta ? <span className="cb-sheet-meta">{meta}</span> : null}
              <span className="cb-sheet-actions">
                {openHref ? (
                  <Link
                    className="cb-btn cb-btn-link cb-sheet-open"
                    href={openHref}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("overlay.openInNew")}
                    title={t("overlay.openInNew")}
                  >
                    <Icon name="external-link" size={14} />
                  </Link>
                ) : null}
                <IconButton
                  label={t("overlay.close")}
                  icon={<Icon name="x" size={14} />}
                  density="dense"
                  onClick={requestClose}
                />
              </span>
            </div>
            <BoxScope kind="sheet">
              {tabs ? <div className="cb-sheet-tabs">{tabs}</div> : null}
              <div className="cb-sheet-body">{children}</div>
              {footer ? <div className="cb-sheet-foot">{footer}</div> : null}
            </BoxScope>
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
