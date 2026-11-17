import { type JSX, useId, useState } from "react";
import { Button } from "../controls/button";
import { isSafeAttachmentHref } from "../display/attachments";
import { Icon } from "../icons/icon";
import { Dialog } from "../overlays/dialog";
import { useDesignT } from "../provider";
import { LoadFailed } from "./file-preview";

/**
 * The in-page zoom of an image attachment (spec §5.6): clicking a thumbnail shows the image over the
 * page instead of opening a new tab — the image alone (up to 86vw × 86vh, less the frame's head,
 * caption and foot), a caption with the name and its size, and a download action. Esc, a click
 * outside and the dialog's own close all close it, and the focus returns to the thumbnail (the
 * `Dialog` it is built on records and restores it). The frame is the dialog, not a second box.
 */
export function ImageZoom({
  open,
  onOpenChange,
  src,
  name,
  size,
  onDownload,
  onRetry,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The thumbnail's source (http(s) or a same-origin path; anything else is not loaded). */
  src: string;
  name: string;
  /** Formatted size (the caller formats the attachment's bytes). */
  size?: string;
  onDownload(): void;
  /**
   * The image failed to load and the caller can reload it (a session refresh, then the same URL with
   * its retry token — a new `src` clears the failure). Absent: the failure stands, without a retry.
   */
  onRetry?(): void;
}): JSX.Element {
  const t = useDesignT();
  const captionId = useId();
  // The source that failed, if that is the current one: a new source is a new attempt, so the
  // failure clears without an effect watching `src`.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("files.preview")}
      size={1060}
      describedBy={captionId}
      footer={
        <Button variant="primary" onClick={onDownload}>
          <Icon name="download" size={14} />
          {t("files.download")}
        </Button>
      }
    >
      <div className="cb-image-zoom" data-part="image-zoom">
        {failed ? (
          <LoadFailed name={name} {...(onRetry ? { onRetry } : {})} />
        ) : isSafeAttachmentHref(src) ? (
          <img
            src={src}
            alt={name}
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(src)}
          />
        ) : null}
      </div>
      <div className="cb-image-zoom-caption" id={captionId} data-part="image-zoom-caption">
        <span className="cb-image-zoom-name" title={name}>
          {name}
        </span>
        {size !== undefined ? <span className="cb-muted">{size}</span> : null}
      </div>
    </Dialog>
  );
}
