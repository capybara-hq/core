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
  // Codes are [A-Za-z0-9]: the segment is used as it arrives (no decode, which throws on a
  // malformed %-escape); anything else is the kernel's 404, as in the route table's prefetch.
  const { code } = await params;
  return <ShareView code={code} />;
}
