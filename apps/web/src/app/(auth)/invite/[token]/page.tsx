import { ApiClientError } from "../../../../lib/api";
import { previewInvitation } from "../../../../lib/members";
import { isKernelUnavailable } from "../../../../lib/server/page";
import { getMe } from "../../../../lib/session";
import InviteView, { type InviteInitial } from "./view";

/**
 * `/invite/[token]` (public): the invitation's preview and whether the visitor has a valid session,
 * read on the server. A refused token (invalid, expired, used) is the page's own problem state,
 * never a not-found page; an unreachable kernel is the error page. Accepting stays in the browser.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const token = decodeURIComponent((await params).token);
  const [preview, signedIn] = await Promise.all([
    previewInvitation(token).then(
      (invite) => ({ invite }),
      (e: unknown) => {
        if (!(e instanceof ApiClientError)) throw e;
        const problem = { status: e.status, code: e.code, message: e.message };
        if (isKernelUnavailable(e)) throw e;
        return { problem };
      },
    ),
    // No session (or an expired one): the visitor signs in or signs up
    getMe().then(
      () => true,
      (e: unknown) => {
        if (e instanceof ApiClientError && e.status === 401) return false;
        throw e;
      },
    ),
  ]);
  const initial: InviteInitial =
    "problem" in preview
      ? { kind: "error", problem: preview.problem }
      : { kind: "ready", invite: preview.invite, signedIn };
  return <InviteView token={token} initial={initial} />;
}
