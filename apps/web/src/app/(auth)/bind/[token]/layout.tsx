import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loginPathFor } from "../../../../lib/auth-sources";
import { pendingBindingQuery } from "../../../../lib/query/auth";
import { isSignedOut } from "../../../../lib/server/page";
import { serverQueryClient, settledQuery } from "../../../../lib/server/query";

/**
 * `/bind/[token]` needs a session: a signed-out visitor goes to sign-in, and back here, before
 * anything renders. The answer is the route's `pendingBindingQuery`, read through the request's
 * query client (once, with the (auth) layout's prefetch); every other answer is the page's.
 */
export default async function BindLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ token: string }>;
}) {
  const token = decodeURIComponent((await params).token);
  const binding = await settledQuery(serverQueryClient(), pendingBindingQuery(token));
  if ("error" in binding && isSignedOut(binding.error)) {
    redirect(loginPathFor(`/bind/${encodeURIComponent(token)}`));
  }
  return children;
}
