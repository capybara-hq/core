import {
  CHANNEL_EXTENSION_POINT,
  IDENTITY_SOURCE_EXTENSION_POINT,
  type IdentitySource,
  type LocalizedName,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { pluginDisplayNames } from "../tools/display-names.js";
import { ExternalIdentities, identityPlugin, type LinkedIdentity } from "./external.js";
import { LoginSourcesService } from "./login-sources.js";

/**
 * What an identity can sign in with (linked accounts page, login extensions spec §6):
 * `unsupported`: its plugin provides no `identity-source@1`; `off`: the login page does not offer
 * that source; `needs_link`: offered, but the row came from an IM bind link (a link intent upgrades
 * it); `on`: offered and the row signs in.
 */
export type IdentityLogin = "unsupported" | "off" | "needs_link" | "on";

/** One row of `GET /api/v1/me/identities`. */
export interface LinkedAccountRow extends LinkedIdentity {
  /** The platform's name: the identity source's label, else the plugin's display name or name. */
  label: LocalizedName;
  /** Its plugin provides `channel@1` (loaded): the identity can talk to agents in IM. */
  channel: boolean;
  login: IdentityLogin;
}

/** A login method the account can link (an enabled source it has no identity of). */
export interface LinkableMethod {
  plugin: string;
  label: LocalizedName;
}

/**
 * The linked accounts page's read (`GET /api/v1/me/identities`): the person's identities with
 * their IM and sign-in capabilities, and the enabled login methods they have no identity of, so
 * the page decides nothing itself. Computed at each read from the registry and the login sources
 * setting (never cached in process).
 */
@Injectable()
export class LinkedAccountsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ExternalIdentities)
    private readonly external: Pick<ExternalIdentities, "listForAccount">,
    @Inject(LoginSourcesService)
    private readonly loginSources: Pick<LoginSourcesService, "enabled" | "providesIdentitySource">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
  ) {}

  async list(
    accountId: string,
  ): Promise<{ identities: LinkedAccountRow[]; linkable: LinkableMethod[] }> {
    const rows = await this.external.listForAccount(accountId);
    const enabled = new Map(
      (await this.loginSources.enabled()).map((e) => [e.plugin, e.source.label] as const),
    );
    const sources = new Map(
      this.registry
        .list("identity-source")
        .filter((e) => e.capability === IDENTITY_SOURCE_EXTENSION_POINT)
        .map((e) => [e.plugin, (e.impl as IdentitySource).label] as const),
    );
    const channels = new Set(
      this.registry
        .list("channel")
        .filter((e) => e.capability === CHANNEL_EXTENSION_POINT)
        .map((e) => e.plugin),
    );
    const plugins = [...new Set(rows.map((r) => identityPlugin(r.source)))];
    const provides = new Map(
      await Promise.all(
        plugins.map(async (p) => [p, await this.loginSources.providesIdentitySource(p)] as const),
      ),
    );
    const names = await pluginDisplayNames(
      this.db.db,
      plugins.filter((p) => !sources.has(p)),
    );
    const identities = rows.map((r): LinkedAccountRow => {
      const plugin = identityPlugin(r.source);
      const label = sources.get(plugin) ?? names.get(plugin) ?? { zh: plugin, en: plugin };
      let login: IdentityLogin;
      if (provides.get(plugin) !== true) login = "unsupported";
      else if (!enabled.has(plugin)) login = "off";
      else login = r.linkedVia === "bind" ? "needs_link" : "on";
      return {
        ...r,
        label: { zh: label.zh, en: label.en },
        channel: channels.has(plugin),
        login,
      };
    });
    const linkable = [...enabled]
      .filter(([plugin]) => !plugins.includes(plugin))
      .map(([plugin, label]) => ({ plugin, label: { zh: label.zh, en: label.en } }));
    return { identities, linkable };
  }
}
