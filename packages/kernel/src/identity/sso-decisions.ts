// The decision a third-party sign-in callback takes on the identity row (spec
// 2026-11-26-login-extensions §4). A leaf module with no service imports: `ExternalIdentities`
// applies the decision under the identity lock, `SsoFlow` re-exports it, and the unit test covers
// the table cell by cell.

/**
 * Why a sign-in started: `signin` from the login page, `link` from the linked accounts page by a
 * signed-in person (links to that person's account, never creates one, never switches the session).
 */
export type SsoIntent = "signin" | "link";

/** How an identity row was made (`null`: a legacy row from before migration 0019, read as `sso`). */
export type SsoRowVia = "bind" | "sso" | "directory" | "local" | null;

export interface SsoDecisionInput {
  intent: SsoIntent;
  /**
   * The account of the web session that both the start and the callback carried; only for
   * `intent: link` (the caller passes it only when the two match).
   */
  sessionAccountId?: string;
  /** The identity row of the external account, if any. */
  row?: { accountId: string; linkedVia: SsoRowVia };
  /**
   * The account a trusted-email merge would link an unlinked identity to (trusted tenant, verified
   * email equal to exactly one account's verified email), if any.
   */
  mergeTarget?: string;
  /** The login source's setting for an unlinked external account. */
  signUp: "link" | "create";
}

/**
 * - `signin`: sign in as the row's account (the row is refreshed).
 * - `refresh`: link intent, the row is already the session account's: refresh it, back to the page.
 * - `upgrade`: link intent, the session account's `bind` row becomes `sso` (`identity.verified`).
 * - `linked`: write a new `sso` row for `accountId` (`identity.linked` with `via`); a sign-in
 *   (merge) signs in as it, a link intent stays in its session.
 * - `link_page`: send the person to the link page (`existingAccountId`: a `bind` row's account,
 *   whose password upgrades it; never shown to the person).
 * - `create`: self sign-up, a new org-less account with this identity.
 * - `error`: refuse with the code.
 */
export type SsoDecision =
  | { kind: "signin"; accountId: string }
  | { kind: "refresh"; accountId: string }
  | { kind: "upgrade"; accountId: string }
  | { kind: "linked"; accountId: string; via: "oauth" | "verified_email" }
  | { kind: "link_page"; existingAccountId?: string }
  | { kind: "create" }
  | { kind: "error"; code: "identity.taken" | "sso.session_mismatch" };

/**
 * The callback's decision on the identity row, spec §4's table cell by cell:
 *
 * | Row | `link` (signed in as A) | `signin` |
 * |---|---|---|
 * | A's (`sso` / `directory` / legacy) | refresh | sign in as A |
 * | A's `bind` | upgrade | link page |
 * | B's | `identity.taken` | sign in as B; B's `bind` row → link page |
 * | none, merge applies | linked to A | linked to the merge target, sign in |
 * | none | linked to A (`oauth`) | `signUp: link` → link page; `create` → create |
 *
 * In `signin` the session plays no part, so "A" and "B" are the same column: only the row's
 * `linked_via` matters. A link intent without its session is a session mismatch.
 */
export function decideSsoCallback(input: SsoDecisionInput): SsoDecision {
  const { row } = input;
  if (input.intent === "link") {
    const me = input.sessionAccountId;
    if (me === undefined) return { kind: "error", code: "sso.session_mismatch" };
    if (row === undefined) return { kind: "linked", accountId: me, via: "oauth" };
    if (row.accountId !== me) return { kind: "error", code: "identity.taken" };
    return row.linkedVia === "bind"
      ? { kind: "upgrade", accountId: me }
      : { kind: "refresh", accountId: me };
  }
  if (row !== undefined) {
    return row.linkedVia === "bind"
      ? { kind: "link_page", existingAccountId: row.accountId }
      : { kind: "signin", accountId: row.accountId };
  }
  if (input.mergeTarget !== undefined) {
    return { kind: "linked", accountId: input.mergeTarget, via: "verified_email" };
  }
  return input.signUp === "create" ? { kind: "create" } : { kind: "link_page" };
}
