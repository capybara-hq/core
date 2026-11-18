import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { shareMetaQuery } from "../../../../lib/query/shares";
import { serverQueryClient, settledQuery } from "../../../../lib/server/query";
import { shareLink } from "../../../../lib/shares";

/**
 * `/s/[code]`: an internal share link needs a member's session (the kernel answers 401
 * `share.sign_in_required`): a visitor without one goes to sign-in, and back here, before
 * anything renders. The answer is the route's `shareMetaQuery`, read through the request's query
 * client (once, with the (auth) layout's prefetch); every other answer is the page's.
 */
export default async function ShareLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ code: string }>;
}) {
  const code = decodeURIComponent((await params).code);
  const meta = await settledQuery(serverQueryClient(), shareMetaQuery(code));
  if ("error" in meta && meta.error instanceof ApiClientError && meta.error.status === 401) {
    redirect(loginPathFor(shareLink("", encodeURIComponent(code))));
  }
  return children;
}
