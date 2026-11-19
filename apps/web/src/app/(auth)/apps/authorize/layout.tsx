import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loginPathFor } from "../../../../lib/auth-sources";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { currentPath } from "../../../../lib/server/page";
import { serverQueryClient, settledQuery } from "../../../../lib/server/query";

/**
 * `/apps/authorize` needs a session. A visitor without one (or with one the kernel no longer
 * accepts) goes to sign-in and back here, with the app's query, before anything renders.
 */
export default async function AppAuthorizeLayout({ children }: { children: ReactNode }) {
  const me = await settledQuery(serverQueryClient(), maybeMeQuery());
  if ("data" in me && me.data === null) redirect(loginPathFor(await currentPath()));
  return children;
}
