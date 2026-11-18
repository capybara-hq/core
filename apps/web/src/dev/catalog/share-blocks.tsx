"use client";

import { CopyField, CsvPreview, HtmlDocumentFrame, SharedFilePage } from "@capybara-hq/design";
import { FILE_FIXTURE, SHARE_FIXTURE } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { csvText } from "./conversation-blocks";
import { RefBlock } from "./ref-block";

// File sharing (file sharing design §4–§6): HtmlDocumentFrame (spec §6.43), CopyField (§6.44) and
// the shared file page (T14, §5.12). The blocks have the same ids and boxes as
// docs/design/reference/src/{html-frame,copy-field,shared-file-page}.html.

const noop = () => {};

/** The fixture report as a document URL: the frame loads it like the kernel's HTML document. */
export const SHARE_DOCUMENT_SRC = `data:text/html;charset=utf-8,${encodeURIComponent(SHARE_FIXTURE.document)}`;

function htmlFrameBlocks(): ReactNode {
  return (
    <RefBlock id="html-frame-ready" width={560} height={360}>
      <HtmlDocumentFrame src={SHARE_DOCUMENT_SRC} title={SHARE_FIXTURE.name} />
    </RefBlock>
  );
}

function copyFieldBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="copy-field-idle" width={480} pad>
        <CopyField label={SHARE_FIXTURE.linkLabel} value={SHARE_FIXTURE.link} />
      </RefBlock>
      <RefBlock id="copy-field-copied" width={480} pad>
        <CopyField label={SHARE_FIXTURE.linkLabel} value={SHARE_FIXTURE.link} state="copied" />
      </RefBlock>
      <RefBlock id="copy-field-manual" width={480} pad>
        <CopyField label={SHARE_FIXTURE.linkLabel} value={SHARE_FIXTURE.link} state="manual" />
      </RefBlock>
    </>
  );
}

const CSV = FILE_FIXTURE.many[1];

function sharedFilePageBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="shared-file-page-loading" width={960} height={560}>
        <SharedFilePage name="" badge="" meta="" onDownload={noop} state="loading" />
      </RefBlock>
      <RefBlock id="shared-file-page-ready" width={960} height={560}>
        <SharedFilePage
          name={SHARE_FIXTURE.name}
          badge={SHARE_FIXTURE.badge}
          meta={SHARE_FIXTURE.meta}
          onDownload={noop}
          state="ready"
        >
          <HtmlDocumentFrame src={SHARE_DOCUMENT_SRC} title={SHARE_FIXTURE.name} />
        </SharedFilePage>
      </RefBlock>
      <RefBlock id="shared-file-page-ready-no-download" width={960} height={560}>
        <SharedFilePage
          name={CSV?.name ?? ""}
          badge={CSV?.type ?? ""}
          meta={SHARE_FIXTURE.meta}
          state="ready"
        >
          <CsvPreview text={csvText()} delimiter="," maxRows={10} />
        </SharedFilePage>
      </RefBlock>
    </>
  );
}

export const SHARE_BLOCKS = {
  "html-frame": htmlFrameBlocks,
  "copy-field": copyFieldBlocks,
  "shared-file-page": sharedFilePageBlocks,
} as const;
