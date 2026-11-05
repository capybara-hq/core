import InviteView from "./view";

/**
 * `/invite/[token]` (public): the view reads the invitation's preview and whether the visitor has
 * a valid session from the cache the (auth) layout prefetched. A refused token (invalid, expired,
 * used) is the page's own problem state, never a not-found page. Accepting stays in the browser.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const token = decodeURIComponent((await params).token);
  return <InviteView token={token} />;
}
