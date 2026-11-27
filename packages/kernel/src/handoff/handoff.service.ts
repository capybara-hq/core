import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { AccountsService } from "../identity/accounts.js";
import { SsoFlow, ssoBrowserBinding } from "../identity/sso.js";
import { withOrgScope } from "../infra/database/org-scope.js";
import { OrgLock } from "../orgs/org-lock.js";
import { browserBinding, OAuthFlow } from "../tools/oauth/flow.js";
import { HandoffTickets } from "./handoff-tickets.js";

/** The binding cookie values this browser already holds (either may be missing or invalid). */
export interface HandoffBrowserBindings {
  oauth?: string | undefined;
  sso?: string | undefined;
}

/** What a redeem answers and the binding cookie the controller writes on this browser. */
export interface HandoffRedeemResult {
  location: string;
  cookie: { name: "cap_oauth" | "cap_sso"; value: string };
}

/**
 * Redeems a browser handoff ticket (shell external authorization spec §2) in the person's own
 * signed-in browser: the ticket is taken first (GETDEL, one redeem wins across replicas), so a
 * mismatch or a refusal spends it too. The flow then starts as a normal start would, in this
 * browser, with the binding value the controller writes as this browser's cookie and the handoff
 * done page as the return page.
 */
@Injectable()
export class HandoffService {
  constructor(
    @Inject(HandoffTickets) private readonly tickets: HandoffTickets,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(OAuthFlow) private readonly oauthFlow: OAuthFlow,
    @Inject(SsoFlow) private readonly ssoFlow: SsoFlow,
  ) {}

  /**
   * Unknown, used, expired or malformed ticket → `handoff.invalid`. The session's account is not
   * the ticket's → `handoff.account_mismatch` naming the ticket's account (details
   * `[{ displayName, email }]`), and no flow starts. A connector ticket re-checks the account's
   * membership and `connectors.use` (`org.not_found` / `forbidden`) under the ticket's org scope,
   * then starts the OAuth flow; a link ticket starts the SSO link intent for the session's account.
   */
  async redeem(
    ticket: string,
    accountId: string,
    bindings: HandoffBrowserBindings,
  ): Promise<HandoffRedeemResult> {
    const rec = await this.tickets.take(ticket);
    if (rec === null) {
      throw new ApiError(
        "handoff.invalid",
        "This authorization link has expired or was already used; start again in the app",
      );
    }
    if (rec.accountId !== accountId) {
      const owner = await this.accounts.get(rec.accountId);
      throw new ApiError(
        "handoff.account_mismatch",
        "This authorization link belongs to another account; sign in as that account or start again in the app",
        [{ displayName: owner?.displayName ?? null, email: owner?.email ?? null }],
      );
    }
    if (rec.kind === "connector") {
      const binding = browserBinding(bindings.oauth);
      // the entry point of this request's org work: the scope comes from the ticket
      const { authorizationUrl } = await withOrgScope(rec.orgId, async () => {
        await this.orgLock.precheck(rec.orgId, accountId, "connectors.use");
        return this.oauthFlow.start(
          rec.orgId,
          rec.connectorId,
          accountId,
          rec.returnTo,
          binding,
          rec,
        );
      });
      return { location: authorizationUrl, cookie: { name: "cap_oauth", value: binding } };
    }
    const binding = ssoBrowserBinding(bindings.sso);
    // a link that cannot start answers the done page with `?error=<code>`: the same location
    const location = await this.ssoFlow.start(
      rec.plugin,
      rec.returnTo,
      binding,
      accountId,
      "link",
      rec,
    );
    return { location, cookie: { name: "cap_sso", value: binding } };
  }
}
