// The browser handoff's web paths and the record a ticket holds: a leaf module (no service
// imports), so both the OAuth connect flow and the SSO flow can build the done page path.

/** What a handoff ticket holds (Redis, under the ticket's hash). */
export type HandoffRecord =
  | {
      kind: "connector";
      accountId: string;
      orgId: string;
      connectorId: string;
      /** The site path the shell started from (already checked as a site path). */
      returnTo: string;
      returnScheme?: string;
    }
  | {
      kind: "identity-link";
      accountId: string;
      plugin: string;
      returnTo: string;
      returnScheme?: string;
    };

/** The web page that redeems a ticket: `<publicUrl>/handoff/<ticket>`. */
export const HANDOFF_PAGE_PATH = "/handoff";
/** The web page a handoff flow's callback returns to (next-intl adds the language prefix). */
export const HANDOFF_DONE_PATH = "/handoff/done";

/**
 * The done page path for a handoff flow, used as the OAuth / SSO state's return page: what was
 * authorized, the page the shell started from and its scheme (when it gave one). The callbacks
 * append their result parameters (`connected` / `oauth_error`, `error`) as for any return page.
 */
export function handoffDonePath(rec: HandoffRecord): string {
  const q = new URLSearchParams({ kind: rec.kind });
  if (rec.kind === "connector") {
    q.set("org", rec.orgId);
    q.set("connector", rec.connectorId);
  } else {
    q.set("plugin", rec.plugin);
  }
  q.set("returnTo", rec.returnTo);
  if (rec.returnScheme !== undefined) q.set("scheme", rec.returnScheme);
  return `${HANDOFF_DONE_PATH}?${q.toString()}`;
}
