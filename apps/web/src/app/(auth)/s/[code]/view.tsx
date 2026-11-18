"use client";

import {
  formatDateTime,
  LoadFailed,
  SharedFilePage,
  StatusPage,
  typeBadge,
  useTimeZone,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { SharePreviewEmbed } from "../../../../components/extension-ui/SharePreviewEmbed";
import { FilePreviewBody } from "../../../../components/file-preview/FilePreviewBody";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { type FileSource, type ShareMeta, sourceUrls } from "../../../../lib/file-source";
import { retryOnMountOf } from "../../../../lib/query/client";
import { shareMetaQuery } from "../../../../lib/query/shares";
import { shareLink } from "../../../../lib/shares";
import { useErrorMessage } from "../../../../lib/use-error-message";

const status = (e: unknown) => (e instanceof ApiClientError ? e.status : 0);

/**
 * `/s/[code]`: a share link (file sharing design §6), on the design's `SharedFilePage`: the bar
 * (type, name, who shared it and the expiry, Download) over the file rendered full width by
 * {@link FilePreviewBody}, the same body as the right panel with the share as its source, so
 * formats never drift. An embed previewer runs in `EmbedTab`'s share mode (a share-scoped token,
 * no navigation). It reads only the share's public routes: no org, session or conversation data.
 * A dead link (unknown, revoked, expired, or an internal one for a non-member) is the one
 * StatusPage 404; an internal link without a session goes to sign-in and back here.
 */
export default function ShareView({ code }: { code: string }) {
  const t = useTranslations("shares.page");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const metaQuery = shareMetaQuery(code);
  const meta = useQuery({ ...metaQuery, retryOnMount: retryOnMountOf(metaQuery.queryKey) });
  const failure = meta.data === undefined ? meta.error : null;
  const signIn = status(failure) === 401;
  const here = shareLink("", encodeURIComponent(code));
  useEffect(() => {
    // the segment layout redirects a document load first; this covers a client render
    if (signIn) router.replace(loginPathFor(here));
  }, [signIn, router, here]);

  if (failure && status(failure) === 404) {
    return (
      <StatusPage
        // no scope above a share link: the path line is empty
        header={{ path: [], title: t("invalidTitle") }}
        kind="404"
        title={t("invalidTitle")}
        description={t("invalidBody")}
      />
    );
  }
  if (failure && !signIn) {
    return (
      <SharedFilePage name={t("sharedFile")} badge="" meta="" state="ready">
        <LoadFailed
          name={t("sharedFile")}
          reason={errorMessage(failure)}
          onRetry={() => void meta.refetch()}
        />
      </SharedFilePage>
    );
  }
  if (meta.data === undefined) {
    return <SharedFilePage name="" badge="" meta="" state="loading" />;
  }
  return <SharedFile code={code} meta={meta.data} />;
}

/** A live share: the bar and the file's body. */
function SharedFile({ code, meta }: { code: string; meta: ShareMeta }) {
  const t = useTranslations("shares.page");
  const timeZone = useTimeZone();
  const source: FileSource = { kind: "share", code, meta };
  const download = () => navigateBrowser(sourceUrls(source).download);
  const line = [
    t("sharedBy", { name: meta.sharedBy }),
    meta.expiresAt === null
      ? t("neverExpires")
      : t("expires", { date: formatDateTime(meta.expiresAt, "full", timeZone) }),
  ].join(" · ");
  return (
    <FilePreviewBody
      source={source}
      // No previewer switch on the page: the first option, in the org's order (design §6); a view
      // previewer that declines the share gives way to the next (FilePreviewBody keeps the choice).
      previewer={null}
      onDownload={download}
      embed={(h) => <SharePreviewEmbed code={code} host={h} />}
      frame={({ state, failure, onRetry, children }) => (
        <SharedFilePage
          name={meta.name}
          badge={typeBadge(meta.name, meta.contentType)}
          meta={line}
          onDownload={download}
          state={state === "loading" ? "loading" : "ready"}
        >
          {state === "failed" ? (
            // The template has no failed state: what failed and Retry, then the fallback card.
            <>
              <LoadFailed
                name={failure?.name ?? meta.name}
                {...(failure?.reason ? { reason: failure.reason } : {})}
                {...(onRetry ? { onRetry } : {})}
              />
              {children}
            </>
          ) : (
            children
          )}
        </SharedFilePage>
      )}
    />
  );
}
