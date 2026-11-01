import { redirect } from "next/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { peekBinding } from "../../../../lib/identities";
import { isKernelUnavailable } from "../../../../lib/server/page";
import BindView, { type BindInitial } from "./view";

/**
 * `/bind/[token]` (signed in): the pending binding, read on the server. Signed out, the visitor
 * goes to sign-in and back here before anything renders; a refused token (`bind.invalid`) is the
 * page's own problem state, never a not-found page. Confirming stays in the browser.
 */
export default async function BindPage({ params }: { params: Promise<{ token: string }> }) {
  const token = decodeURIComponent((await params).token);
  const here = `/bind/${encodeURIComponent(token)}`;
  const initial = await peekBinding(token).then(
    (r): BindInitial => ({ kind: "ready", binding: r.binding }),
    (e: unknown): BindInitial | "sign-in" => {
      if (!(e instanceof ApiClientError)) throw e;
      if (e.status === 401) return "sign-in";
      const problem = { status: e.status, code: e.code, message: e.message };
      if (isKernelUnavailable(e)) throw e;
      return { kind: "error", problem };
    },
  );
  if (initial === "sign-in") redirect(loginPathFor(here));
  return <BindView token={token} initial={initial} />;
}
