import { redirect } from "next/navigation";
import { listAuthSources, parseLoginError, safeReturnTo } from "../../../lib/auth-sources";
import { getMe } from "../../../lib/session";
import LoginView from "./view";

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Where a signed-in visitor goes: `returnTo`, unless it is a sign-in page itself (a loop). */
function onward(returnTo: string): string {
  const path = returnTo.split(/[?#]/)[0] ?? "/";
  return path === "/login" || path === "/setup" ? "/" : returnTo;
}

/**
 * `/login` (the layout already sent a deployment without an admin to `/setup`): `?returnTo=` and
 * `?error=` come from the query. A visitor with a valid session goes to `returnTo` before anything
 * renders; otherwise the form renders with the sign-in sources, read on the server (a failure only
 * hides the third-party buttons).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[]; error?: string | string[] }>;
}) {
  const q = await searchParams;
  const returnTo = safeReturnTo(one(q.returnTo));
  // Any failure of the session read (none, expired, the kernel unreachable) shows the form; the
  // sources failing only hides the third-party buttons.
  const [signedIn, sources] = await Promise.all([
    getMe().then(
      () => true,
      () => false,
    ),
    listAuthSources().then(
      (r) => r.sources,
      () => [],
    ),
  ]);
  if (signedIn) redirect(onward(returnTo));
  const code = one(q.error);
  const error = parseLoginError(
    code === undefined ? "" : new URLSearchParams({ error: code }).toString(),
  );
  return <LoginView returnTo={returnTo} error={error} sources={sources} />;
}
