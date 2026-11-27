import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { HandoffService } from "./handoff.service.js";
import { HandoffTicketsModule } from "./handoff-tickets.js";

/**
 * Browser handoffs (shell external authorization spec): the redeem that starts a ticket's OAuth
 * connect (`ToolsModule`'s `OAuthFlow`) or login-method link (`IdentityModule`'s `SsoFlow`) in the
 * person's signed-in browser. The tickets themselves are `HandoffTicketsModule`'s.
 */
@Module({
  imports: [IdentityModule, ToolsModule, HandoffTicketsModule],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}
