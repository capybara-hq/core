import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { signedInTarget } from "../../../lib/auth-sources";
import { maybeMeQuery } from "../../../lib/query/shell";
import { LINK_PAGE_PATH } from "../../../lib/routes";
import { currentPath } from "../../../lib/server/page";
import { serverQueryClient, settledQuery } from "../../../lib/server/query";
import { serverNeedsSetup } from "../../../lib/server-setup";

/**
 * `/login` decides on the server before it renders: a deployment without an admin goes to the
 * setup wizard, a visitor with a valid session goes on to `returnTo`. The session is the route's
 * `maybeMeQuery`, read through the request's query client (once, with the (auth) layout's
 * prefetch); any failure of it shows the form. The link page (`/login/link`) is shown to a
 * signed-in visitor too: finishing it signs in as the account whose password is entered.
 */
export default async function LoginLayout({ children }: { children: ReactNode }) {
  const [needsSetup, me] = await Promise.all([
    serverNeedsSetup(),
    settledQuery(serverQueryClient(), maybeMeQuery()),
  ]);
  if (needsSetup === true) redirect("/setup");
  const path = await currentPath();
  const linkPage = (path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") === LINK_PAGE_PATH;
  if ("data" in me && me.data !== null && !linkPage) redirect(signedInTarget(path));
  return children;
}
