import { Button, LinkButton } from "../controls/index";
import { StatusPage } from "./status-page";

export type DesktopOnlyNoticeProps = {
  title: string;
  description: string;
  /** The page's full URL, shown in the code font so it can be read and copied. */
  url: string;
  copyLabel: string;
  backLabel: string;
  /** Where the primary button goes: the conversation home. */
  backHref: string;
  onCopy(): void;
};

/**
 * 「请在电脑上管理」 (mobile touch plan Task 29): the StatusPage form a management page shows on a
 * touch device: the title, one sentence, the page's URL in the code font, 复制链接 and 回到对话 as
 * the primary. Presentation only; the kernel still decides access.
 */
export function DesktopOnlyNotice({
  title,
  description,
  url,
  copyLabel,
  backLabel,
  backHref,
  onCopy,
}: DesktopOnlyNoticeProps) {
  return (
    <StatusPage
      kind="desktop-only"
      header={{ path: [], title, titleHidden: true }}
      title={title}
      description={description}
      action={
        <div className="cb-desktop-only-body" data-part="desktop-only">
          <span className="cb-desktop-only-url" data-part="desktop-only-url">
            {url}
          </span>
          <div className="cb-desktop-only-actions">
            <Button onClick={onCopy}>{copyLabel}</Button>
            <LinkButton href={backHref} variant="primary">
              {backLabel}
            </LinkButton>
          </div>
        </div>
      }
    />
  );
}
