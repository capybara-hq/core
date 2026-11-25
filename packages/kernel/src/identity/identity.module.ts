import { Module } from "@nestjs/common";
import { SetupLockModule } from "../admin/setup-lock.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { PermissionAuthorityModule } from "../sandbox/permission-authority.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { AccountAvatarsService } from "./account-avatars.service.js";
import { AccountsModule } from "./accounts.js";
import { ApiTokenService } from "./api-tokens.js";
import { AppAuthService } from "./app-auth.js";
import { IdentityBinding } from "./binding.js";
import { ExternalIdentities } from "./external.js";
import { ExternalIdentityLock } from "./external-identity-lock.js";
import { InitialPasswords } from "./initial-passwords.js";
import { LoginSourcesService } from "./login-sources.js";
import { SessionService } from "./sessions.js";
import { SettingsService } from "./settings.js";
import { SsoFlow } from "./sso.js";
import { SsoLinkTickets } from "./sso-link.js";
import { SuperAdminLockModule } from "./super-admin.js";

/**
 * Identity: accounts, sessions, API tokens, deployment settings and the super admin lock,
 * external identities with IM binding and third-party sign-in, native-app sign-in, and the
 * person's own avatar uploads.
 */
@Module({
  imports: [
    PermissionAuthorityModule,
    AccountsModule,
    OrgLockModule,
    SetupLockModule,
    SuperAdminLockModule,
    ExtensionRegistryModule,
    StorageModule,
  ],
  providers: [
    AccountAvatarsService,
    SessionService,
    ApiTokenService,
    SettingsService,
    ExternalIdentityLock,
    LoginSourcesService,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
    SsoLinkTickets,
    InitialPasswords,
    AppAuthService,
  ],
  exports: [
    AccountsModule,
    AccountAvatarsService,
    SessionService,
    ApiTokenService,
    SettingsService,
    SuperAdminLockModule,
    LoginSourcesService,
    ExternalIdentities,
    IdentityBinding,
    SsoFlow,
    SsoLinkTickets,
    InitialPasswords,
    AppAuthService,
  ],
})
export class IdentityModule {}
