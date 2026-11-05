import BindView from "./view";

/**
 * `/bind/[token]` (signed in; the layout sent a signed-out visitor to sign-in and back): the view
 * reads the pending binding from the cache the (auth) layout prefetched. A refused token
 * (`bind.invalid`) is the page's own problem state, never a not-found page. Confirming stays in
 * the browser.
 */
export default async function BindPage({ params }: { params: Promise<{ token: string }> }) {
  const token = decodeURIComponent((await params).token);
  return <BindView token={token} />;
}
