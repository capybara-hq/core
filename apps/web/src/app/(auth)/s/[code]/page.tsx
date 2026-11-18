import type { Metadata } from "next";
import ShareView from "./view";

/** A share link is never indexed, and its code never leaves as a referrer (design §6). */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/s/[code]` (public, file sharing design §6): the view reads the share's metadata from the
 * cache the (auth) layout prefetched; the segment layout already sent a visitor of an internal
 * link without a session to sign in. A dead link is the view's own 404 page.
 */
export default async function SharePage({ params }: { params: Promise<{ code: string }> }) {
  const code = decodeURIComponent((await params).code);
  return <ShareView code={code} />;
}
