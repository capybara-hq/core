import type { Metadata } from "next";
import HandoffView from "./view";

/** The ticket is in the address: the page never sends it on as a referrer. */
export const metadata: Metadata = { referrer: "no-referrer" };

/**
 * `/handoff/[ticket]` (signed in; the layout sent a signed-out visitor to sign-in and back): a
 * native shell opened it in the system browser. The view redeems the ticket once and goes on to
 * the provider's authorize page in this browser.
 */
export default async function HandoffPage({ params }: { params: Promise<{ ticket: string }> }) {
  const ticket = decodeURIComponent((await params).ticket);
  return <HandoffView ticket={ticket} />;
}
