import { Module } from "@nestjs/common";
import { SetupLockModule } from "../admin/setup-lock.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { AccountsModule } from "./accounts.js";
import { ApiTokenService } from "./api-tokens.js";
import { IdentityBinding } from "./binding.js";
import { ExternalIdentities } from "./external.js";
import { ExternalIdentityLock } from "./external-identity-lock.js";
import { SessionService } from "./sessions.js";
import { SettingsService } from "./settings.js";
import { SsoFlow } from "./sso.js";
import { SuperAdminLockModule } from "./super-admin.js";

/**
 * Identity: accounts, sessions, API tokens, deployment settings and the super admin lock,
 * external identities with IM binding and third-party sign-in.
 */
@Module({
  imports: [
    AccountsModule,
    OrgLockModule,
    SetupLockModule,
    SuperAdminLockModule,
    ExtensionRegistryModule,
  ],
  providers: [
    SessionService,
    ApiTokenService,
    SettingsService,
    ExternalIdentityLock,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
  ],
  exports: [
    AccountsModule,
    SessionService,
    ApiTokenService,
    SettingsService,
    SuperAdminLockModule,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
  ],
})
export class IdentityModule {}
