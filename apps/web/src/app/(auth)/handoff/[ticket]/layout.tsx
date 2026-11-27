import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loginPathFor } from "../../../../lib/auth-sources";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { serverQueryClient, settledQuery } from "../../../../lib/server/query";

/**
 * `/handoff/[ticket]` needs a session (shell external authorization spec §2): a signed-out visitor
 * (or one whose session the kernel no longer accepts) goes to sign-in, and back here, before
 * anything renders. The session is the route's `maybeMeQuery`, read through the request's query
 * client (once, with the (auth) layout's prefetch); any other answer is the page's.
 */
export default async function HandoffLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ ticket: string }>;
}) {
  const ticket = decodeURIComponent((await params).ticket);
  const me = await settledQuery(serverQueryClient(), maybeMeQuery());
  if ("data" in me && me.data === null) {
    redirect(loginPathFor(`/handoff/${encodeURIComponent(ticket)}`));
  }
  return children;
}
