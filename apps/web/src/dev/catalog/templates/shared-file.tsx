import { HtmlDocumentFrame, SharedFilePage } from "@capybara-hq/design";
import { SHARE_FIXTURE } from "@capybara-hq/design/fixtures";
import { SHARE_DOCUMENT_SRC } from "../share-blocks";

/** T14 shared file: the public page behind a share link (no shell), an HTML report. */
export function SharedFileTemplate() {
  return (
    <SharedFilePage
      name={SHARE_FIXTURE.name}
      badge={SHARE_FIXTURE.badge}
      meta={SHARE_FIXTURE.meta}
      onDownload={() => {}}
      state="ready"
    >
      <HtmlDocumentFrame src={SHARE_DOCUMENT_SRC} title={SHARE_FIXTURE.name} />
    </SharedFilePage>
  );
}
