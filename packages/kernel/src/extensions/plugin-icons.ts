import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { requestable } from "../catalog/scope.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";

/** Who reads the icons: the super admin (admin routes) or one org (its routes, its visibility). */
export type PluginIconScope = { kind: "admin" } | { kind: "org"; orgId: string; isAdmin: boolean };

/** The icon scope of an org route's caller (its org and role). */
export const orgIconScope = (org: { orgId: string; role: OrgRole }): PluginIconScope => ({
  kind: "org",
  orgId: org.orgId,
  isAdmin: roleAtLeast(org.role, "admin"),
});

const enc = encodeURIComponent;

/**
 * Plugin icons for the things a plugin brings (channels, extensions, model providers; maintainer
 * decision 2026-11-08): extension name -> the URL of its plugin's icon, the catalog item of the
 * same name (one live item per name). A name is present only when the item's latest version has
 * an icon and the reader may load it: the admin scope gets `GET /api/v1/admin/catalog/items/:id/icon`
 * for every live item; an org gets `GET /api/v1/orgs/:orgId/catalog/:itemId/icon` only for items
 * its catalog shows (members never see disabled items, a `named` item only for its listed orgs or
 * as requestable, an org-owned item only for its owner or through the share gate, an upload
 * waiting for confirmation only for its owner). The URL carries the version, so a new icon is not
 * hidden by the browser cache. Stateless; one query per call (two for an org: its list rows).
 */
@Injectable()
export class PluginIcons {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /** Extension (plugin) name -> its icon's URL; names without one are absent. */
  async many(names: string[], scope: PluginIconScope): Promise<Map<string, string>> {
    const icons = await this.resolve("name", names, scope);
    return new Map(icons.map((i) => [i.name, i.url]));
  }

  /** Catalog item id -> its icon's URL (a list of items); items without one are absent. */
  async ofItems(ids: string[], scope: PluginIconScope): Promise<Map<string, string>> {
    const icons = await this.resolve("id", ids, scope);
    return new Map(icons.map((i) => [i.id, i.url]));
  }

  private async resolve(
    by: "name" | "id",
    keys: string[],
    scope: PluginIconScope,
  ): Promise<{ id: string; name: string; url: string }[]> {
    const out: { id: string; name: string; url: string }[] = [];
    const unique = [...new Set(keys)];
    if (unique.length === 0) return out;
    const rows = await this.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "i.id").onRef("v.version", "=", "i.latest_version"),
      )
      .select([
        "i.id",
        "i.name",
        "i.scope",
        "i.builtin",
        "i.disabled",
        "i.shown_to_others",
        "i.owner_org_id",
        "i.shareable",
        "i.awaiting_confirmation",
        "i.latest_version",
        sql<string | null>`v.manifest->>'icon'`.as("icon"),
        "v.files",
      ])
      .where(by === "name" ? "i.name" : "i.id", "in", unique)
      .where("i.deleted_at", "is", null)
      .execute();
    const withIcon = rows.filter((r) => {
      if (r.icon === null) return false;
      const path = packagePath(r.icon);
      return (r.files as { path: string }[]).some((f) => f.path === path);
    });
    if (withIcon.length === 0) return out;
    if (scope.kind === "admin") {
      for (const r of withIcon) {
        const url = `/api/v1/admin/catalog/items/${enc(r.id)}/icon?v=${enc(r.latest_version)}`;
        out.push({ id: r.id, name: r.name, url });
      }
      return out;
    }
    const { orgId, isAdmin } = scope;
    const listed = new Set(
      (
        await this.db
          .selectFrom("catalog_item_scope_orgs")
          .select("item_id")
          .where("org_id", "=", orgId)
          .where(
            "item_id",
            "in",
            withIcon.map((r) => r.id),
          )
          .execute()
      ).map((r) => r.item_id),
    );
    for (const r of withIcon) {
      const inList = listed.has(r.id);
      const own = r.owner_org_id === orgId;
      const visible =
        (isAdmin || !r.disabled) &&
        (!r.awaiting_confirmation || own) &&
        // the share gate: another org's item reaches this org only when shareable or listed here
        (r.owner_org_id === null || own || r.shareable || inList) &&
        (r.builtin || r.scope !== "named" || inList || requestable(r, inList));
      if (visible) {
        const url = `/api/v1/orgs/${enc(orgId)}/catalog/${enc(r.id)}/icon?v=${enc(r.latest_version)}`;
        out.push({ id: r.id, name: r.name, url });
      }
    }
    return out;
  }
}
