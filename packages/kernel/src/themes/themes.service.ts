import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { readUiTheme } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { DEFAULT_ORG_THEME, readOrgSettings } from "../orgs/settings.service.js";
import {
  eligiblePlatformDefault,
  type ListedTheme,
  type OrgAvatars,
  type ThemeDefinition,
  type ThemeRef,
  themeAvatarPresets,
  themeDefinitions,
  themeOnForAccount,
  themeOnIn,
  themeRefOf,
  themeSwatches,
  themesOnIn,
} from "./theme-state.js";

/** `GET /api/v1/orgs/:orgId/themes` (themes spec §9). */
export interface OrgThemes {
  /** The themes on in the org, by English name. */
  themes: ListedTheme[];
  /** The viewer's theme ({@link ThemesService.resolve}); null: the built-in theme. */
  resolved: ThemeRef | null;
  /**
   * The org's setting as stored: its default (null: follow the platform) and the personal lock.
   * The stored id may name a theme absent from `themes` (it went off in the org after it was
   * chosen; resolution skips it): the UI shows it as unavailable, not as selected.
   */
  org: { id: string | null; personal: "allowed" | "locked" };
  /**
   * The agent avatar presets of the org's effective default theme ({@link ThemesService.avatarPresets};
   * the same for every member, never the viewer's pick): the built-ins it hides and the presets it
   * adds, whose `key` an avatar input sends as its preset id.
   */
  avatars: { hidden: string[]; presets: { key: string; name: LocalizedName; url: string }[] };
}

/**
 * Which theme applies (themes spec §7) and the org's theme listing. Read-only; the levels are
 * written by their settings services (deployment, org, person), which check availability with the
 * same predicates (`theme-state.ts`).
 */
@Injectable()
export class ThemesService {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /** The themes on in the org with their references and swatches, by English name then id. */
  async listForOrg(orgId: string): Promise<ListedTheme[]> {
    const on = await themesOnIn(this.db.db, orgId);
    const defs = await themeDefinitions(
      this.db.db,
      on.map((c) => c.id),
    );
    const out: ListedTheme[] = [];
    for (const c of on) {
      const d = defs.get(c.id);
      if (!d) continue;
      out.push({
        ...themeRefOf(c.id, d.version, d.definition, d.plugin),
        swatches: themeSwatches(d.definition),
      });
    }
    return out.sort((a, b) =>
      a.name.en < b.name.en ? -1 : a.name.en > b.name.en ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  /**
   * The theme of a signed-in page in the org (spec §7): the person's pick if it is on in the org
   * and the org does not lock; else the org's default if on; else the platform default if on in
   * the org; else null (the built-in theme). An unavailable choice is skipped, never an error.
   * `accountId` null (a service token): no personal pick.
   */
  async resolve(orgId: string, accountId: string | null): Promise<ThemeRef | null> {
    return (await this.forOrg(orgId, accountId)).resolved;
  }

  /** The platform default for pages before sign-in, when it is still eligible (spec §7); else null. */
  async platformDefault(): Promise<ThemeRef | null> {
    const { id } = await readUiTheme(this.db.db);
    if (id === null || (await eligiblePlatformDefault(this.db.db, id)) === null) return null;
    const d = (await themeDefinitions(this.db.db, [id])).get(id);
    return d ? themeRefOf(id, d.version, d.definition, d.plugin) : null;
  }

  /**
   * The listing, the viewer's resolved theme and the org's setting. Separate reads, not one
   * snapshot: a change committed between them shows at the next read.
   */
  async forOrg(orgId: string, accountId: string | null): Promise<OrgThemes> {
    const themes = await this.listForOrg(orgId);
    const org = (await readOrgSettings(this.db.db, orgId)).theme ?? DEFAULT_ORG_THEME;
    const pick =
      accountId === null || org.personal === "locked"
        ? null
        : ((
            await this.db
              .selectFrom("accounts")
              .select("theme")
              .where("id", "=", accountId)
              .executeTakeFirst()
          )?.theme ?? null);
    const platform = (await readUiTheme(this.db.db)).id;
    const on = (id: string | null) => (id === null ? undefined : themes.find((t) => t.id === id));
    const hit = on(pick) ?? on(org.id) ?? on(platform);
    let resolved: ThemeRef | null = null;
    if (hit) {
      const { swatches: _swatches, ...ref } = hit;
      resolved = ref;
    }
    const { hidden, presets } = await this.avatarPresets(orgId);
    return {
      themes,
      resolved,
      org: { id: org.id, personal: org.personal },
      avatars: { hidden, presets: presets.map(({ key, name, url }) => ({ key, name, url })) },
    };
  }

  /**
   * The org's effective default theme (theme brand coverage spec §4): the org's default if it is
   * on in the org, else the platform default if it is on in the org, else null. The same
   * predicates as {@link forOrg} without the personal pick: what every member of the org shares.
   */
  async orgDefault(orgId: string): Promise<(ThemeDefinition & { id: string }) | null> {
    const org = (await readOrgSettings(this.db.db, orgId)).theme ?? DEFAULT_ORG_THEME;
    const platform = (await readUiTheme(this.db.db)).id;
    for (const id of [org.id, platform]) {
      if (id === null || !(await themeOnIn(this.db.db, orgId, id))) continue;
      const d = (await themeDefinitions(this.db.db, [id])).get(id);
      if (d) return { id, ...d };
    }
    return null;
  }

  /**
   * The agent avatar presets of the org's effective default theme ({@link orgDefault}): the
   * built-ins it hides and the presets it adds, each with what a stored avatar pins. No default
   * theme in effect: nothing hidden, no presets.
   */
  async avatarPresets(orgId: string): Promise<OrgAvatars> {
    const d = await this.orgDefault(orgId);
    return d
      ? themeAvatarPresets(d.id, d.version, d.definition, d.plugin)
      : { hidden: [], presets: [] };
  }

  /** A live theme's name (the super admin's summaries); null when there is no such theme. */
  async nameOf(id: string): Promise<LocalizedName | null> {
    return (await themeDefinitions(this.db.db, [id])).get(id)?.definition.name ?? null;
  }

  /** Theme `id`'s name if it is on in the org, else null (a summary never names another org's theme). */
  async nameIn(orgId: string, id: string): Promise<LocalizedName | null> {
    return (await themeOnIn(this.db.db, orgId, id)) ? this.nameOf(id) : null;
  }

  /** Theme `id`'s name if it is on in one of the person's orgs, else null (same reason). */
  async nameForAccount(accountId: string, id: string): Promise<LocalizedName | null> {
    return (await themeOnForAccount(this.db.db, accountId, id)) ? this.nameOf(id) : null;
  }
}
