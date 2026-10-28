import { Module } from "@nestjs/common";
import { SetupLockModule } from "../admin/setup-lock.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { AccountsService } from "./accounts.js";
import { ApiTokenService } from "./api-tokens.js";
import { IdentityBinding } from "./binding.js";
import { EnterpriseAdminLock } from "./enterprise-admin.js";
import { ExternalIdentities } from "./external.js";
import { ExternalIdentityLock } from "./external-identity-lock.js";
import { SessionService } from "./sessions.js";
import { SettingsService } from "./settings.js";
import { SsoFlow } from "./sso.js";

/**
 * Identity: accounts, sessions, API tokens, deployment settings and the enterprise admin lock,
 * external identities with IM binding and third-party sign-in.
 */
@Module({
  imports: [OrgLockModule, SetupLockModule, ExtensionsModule],
  providers: [
    AccountsService,
    SessionService,
    ApiTokenService,
    SettingsService,
    EnterpriseAdminLock,
    ExternalIdentityLock,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
  ],
  exports: [
    AccountsService,
    SessionService,
    ApiTokenService,
    SettingsService,
    EnterpriseAdminLock,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
  ],
})
export class IdentityModule {}
