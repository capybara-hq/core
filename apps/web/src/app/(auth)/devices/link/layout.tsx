import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loginPathFor } from "../../../../lib/auth-sources";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { currentPath } from "../../../../lib/server/page";
import { serverQueryClient, settledQuery } from "../../../../lib/server/query";

/**
 * `/devices/link` needs a session (it is not a public path: the proxy already sends a visitor
 * without cookies to sign-in). A session the kernel no longer accepts goes to sign-in too, and back here
 * with its `?code=`, before anything renders. The session is the route's `maybeMeQuery`, read
 * through the request's query client (once, with the (auth) layout's prefetch); every other
 * answer is the page's.
 */
export default async function DeviceLinkLayout({ children }: { children: ReactNode }) {
  const me = await settledQuery(serverQueryClient(), maybeMeQuery());
  if ("data" in me && me.data === null) redirect(loginPathFor(await currentPath()));
  return children;
}
