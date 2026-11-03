import { parseLoginError, safeReturnTo } from "../../../lib/auth-sources";
import LoginView from "./view";

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * `/login` (the layout already sent a deployment without an admin to `/setup`, and a signed-in
 * visitor on): `?returnTo=` and `?error=` come from the query. The view reads the sign-in sources
 * from the cache the (auth) layout prefetched.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[]; error?: string | string[] }>;
}) {
  const q = await searchParams;
  const code = one(q.error);
  const error = parseLoginError(
    code === undefined ? "" : new URLSearchParams({ error: code }).toString(),
  );
  return <LoginView returnTo={safeReturnTo(one(q.returnTo))} error={error} />;
}
