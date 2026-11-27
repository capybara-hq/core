import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { AccountsService } from "../identity/accounts.js";
import type { UserPrincipal } from "../identity/principal.js";
import { SsoFlow, ssoBrowserBinding } from "../identity/sso.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { withOrgScope } from "../infra/database/org-scope.js";
import { authorizeOrgAction } from "../orgs/org.guard.js";
import { browserBinding, OAuthFlow } from "../tools/oauth/flow.js";
import { assertReturnSchemeAllowed } from "./app-schemes.js";
import { HandoffTickets } from "./handoff-tickets.js";

/** The binding cookie values this browser already holds (either may be missing or invalid). */
export interface HandoffBrowserBindings {
  oauth?: string | undefined;
  sso?: string | undefined;
}

/**
 * What a redeem answers, and which binding cookie the controller writes on this browser with
 * which value: `oauth` (`cap_oauth`, the connector flow) or `sso` (`cap_sso`, the link flow).
 */
export interface HandoffRedeemResult {
  location: string;
  binding: { flow: "oauth" | "sso"; value: string };
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
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(OAuthFlow) private readonly oauthFlow: OAuthFlow,
    @Inject(SsoFlow) private readonly ssoFlow: SsoFlow,
  ) {}

  /**
   * Unknown, used, expired or malformed ticket → `handoff.invalid`. The session's account is not
   * the ticket's → `handoff.account_mismatch` naming the ticket's account (details
   * `[{ login, displayName, email }]`, `login` its local login or null), and no flow starts. The
   * ticket's return scheme is checked again (`handoff.scheme_not_allowed` once a super admin
   * removed it). A connector ticket re-checks the org role as the start's org guard does, under
   * the ticket's org scope (non-member or deleted org → `org.not_found`, role too low →
   * `forbidden`), then starts the OAuth flow; a link ticket starts the SSO link intent.
   */
  async redeem(
    ticket: string,
    principal: UserPrincipal,
    bindings: HandoffBrowserBindings,
  ): Promise<HandoffRedeemResult> {
    const accountId = principal.account.id;
    const rec = await this.tickets.take(ticket);
    if (rec === null) {
      throw new ApiError(
        "handoff.invalid",
        "This authorization link has expired or was already used; start again in the app",
      );
    }
    if (rec.accountId !== accountId) {
      const [owner, logins] = await Promise.all([
        this.accounts.get(rec.accountId),
        this.accounts.localLogins([rec.accountId]),
      ]);
      throw new ApiError(
        "handoff.account_mismatch",
        "This authorization link belongs to another account; sign in as that account or start again in the app",
        [
          {
            login: logins.get(rec.accountId) ?? null,
            displayName: owner?.displayName ?? null,
            email: owner?.email ?? null,
          },
        ],
      );
    }
    assertReturnSchemeAllowed(this.config.get(), rec.returnScheme);
    if (rec.kind === "connector") {
      const value = browserBinding(bindings.oauth);
      // the entry point of this request's org work: the scope comes from the ticket
      const { authorizationUrl } = await withOrgScope(rec.orgId, async () => {
        await authorizeOrgAction(this.db.db, principal, rec.orgId, "connectors.use");
        return this.oauthFlow.start(
          rec.orgId,
          rec.connectorId,
          accountId,
          rec.returnTo,
          value,
          rec,
        );
      });
      return { location: authorizationUrl, binding: { flow: "oauth", value } };
    }
    const value = ssoBrowserBinding(bindings.sso);
    // a link that cannot start answers the done page with `?error=<code>`: the same location
    const location = await this.ssoFlow.start(
      rec.plugin,
      rec.returnTo,
      value,
      accountId,
      "link",
      rec,
    );
    return { location, binding: { flow: "sso", value } };
  }
}
