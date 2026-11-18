import type { JSX, ReactNode } from "react";
import { Button } from "../controls/button";
import { TypeBadge } from "../conversation/files";
import { SkeletonText } from "../display/skeleton";
import { Icon } from "../icons/icon";
import { BoxScope } from "../layout/box";
import { useDesignT } from "../provider";

export type SharedFilePageProps = {
  /** The file name; an empty string while loading draws a skeleton bar. */
  name: string;
  /** The type badge ("HTML"); empty while loading. */
  badge: string;
  /** Already localized: "张三 分享 · 2026-11-25 过期" / "Shared by 张三 · expires 2026-11-25". */
  meta: string;
  /** Downloads the file; absent: no Download button. */
  onDownload?(): void;
  state: "loading" | "ready";
  /** The file body (a previewer or the HTML document frame), full width, the remaining height. */
  children?: ReactNode;
};

/**
 * T14 shared file (spec §5.12, file sharing design §6): the public page behind a share link. No
 * shell and no sidebar: a top bar (type, name, who shared it and the expiry, Download) over the
 * file, rendered across the full width exactly as the right panel's body would (the same `panel-2`
 * ground and previewers). Loading keeps the bar, draws unknown text as skeleton bars, shows the
 * panel's loading line in the body and announces once (`aria-busy`).
 */
export function SharedFilePage({
  name,
  badge,
  meta,
  onDownload,
  state,
  children,
}: SharedFilePageProps): JSX.Element {
  const t = useDesignT();
  const loading = state === "loading";
  return (
    // A page on its own ground: what it previews is on a page, never inside a box.
    <BoxScope kind={null}>
      <div
        className="cb-shared-page"
        data-template="SharedFilePage"
        data-part="shared-file-page"
        data-state={state}
        aria-busy={loading ? true : undefined}
      >
        <header className="cb-shared-bar" data-part="shared-file-bar">
          {badge !== "" ? <TypeBadge label={badge} /> : null}
          {name !== "" ? (
            <h1 className="cb-shared-name" data-part="shared-file-name" title={name}>
              {name}
            </h1>
          ) : (
            <SkeletonText width={200} />
          )}
          {meta !== "" ? (
            <span className="cb-shared-meta" data-part="shared-file-meta">
              {meta}
            </span>
          ) : loading ? (
            <SkeletonText width={160} size="small" />
          ) : null}
          <span className="cb-shared-grow" />
          {onDownload && !loading ? (
            <Button onClick={onDownload}>
              <Icon name="download" size={14} />
              {t("sharedPage.download")}
            </Button>
          ) : null}
        </header>
        <main className="cb-shared-body" data-part="shared-file-body">
          {loading ? (
            <div className="cb-preview-center cb-muted" data-part="preview-loading">
              {t("files.loadingPreview")}
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </BoxScope>
  );
}
