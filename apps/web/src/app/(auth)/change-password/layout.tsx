import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loginPathFor } from "../../../lib/auth-sources";
import { maybeMeQuery } from "../../../lib/query/shell";
import { HOME_PATH } from "../../../lib/routes";
import { serverQueryClient, settledQuery } from "../../../lib/server/query";
import { CHANGE_PASSWORD_PATH } from "../../../lib/session";

/**
 * `/change-password` decides on the server before it renders: signed out goes to sign-in (and back
 * here), an account with nothing to change goes home. The session is the route's `maybeMeQuery`,
 * read through the request's query client (once, with the (auth) layout's prefetch); another
 * failure of it shows the form.
 */
export default async function ChangePasswordLayout({ children }: { children: ReactNode }) {
  const me = await settledQuery(serverQueryClient(), maybeMeQuery());
  if ("data" in me && me.data === null) redirect(loginPathFor(CHANGE_PASSWORD_PATH));
  if ("data" in me && me.data !== null && me.data.account.mustChangePassword !== true) {
    redirect(HOME_PATH);
  }
  return children;
}
