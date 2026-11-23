import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type CatalogIcon, readCatalogDisplayFiles } from "../catalog/catalog-content.js";
import { iconProblem } from "../catalog/plugin-package.js";
import { type PluginScope, requestable } from "../catalog/scope.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { UUID_RE } from "../ui/registry.js";

/** Who reads the icons: the super admin (admin routes) or one org (its routes, its visibility). */
export type PluginIconScope = { kind: "admin" } | { kind: "org"; orgId: string; isAdmin: boolean };

/** The icon scope of an org route's caller (its org and role). */
export const orgIconScope = (org: { orgId: string; role: OrgRole }): PluginIconScope => ({
  kind: "org",
  orgId: org.orgId,
  isAdmin: roleAtLeast(org.role, "admin"),
});

const enc = encodeURIComponent;

/** The catalog item columns {@link orgVisibleItems} reads. */
export interface OrgVisibilityRow {
  id: string;
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
  shown_to_others: boolean;
  owner_org_id: string | null;
  shareable: boolean;
  awaiting_confirmation: boolean;
}

/**
 * The rows of live catalog items the org's catalog shows (one query for the org's list rows):
 * members never see disabled items, an upload waiting for confirmation only its owner, another
 * org's item only when shareable or listed here (the share gate), a `named` item only its listed
 * orgs or as requestable. Shared by the plugin icons and the setup guides.
 */
export async function orgVisibleItems<T extends OrgVisibilityRow>(
  db: KernelDb,
  rows: T[],
  orgId: string,
  isAdmin: boolean,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const listed = new Set(
    (
      await db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("org_id", "=", orgId)
        .where(
          "item_id",
          "in",
          rows.map((r) => r.id),
        )
        .execute()
    ).map((r) => r.item_id),
  );
  return rows.filter((r) => {
    const inList = listed.has(r.id);
    const own = r.owner_org_id === orgId;
    return (
      (isAdmin || !r.disabled) &&
      (!r.awaiting_confirmation || own) &&
      // the share gate: another org's item reaches this org only when shareable or listed here
      (r.owner_org_id === null || own || r.shareable || inList) &&
      (r.builtin || r.scope !== "named" || inList || requestable(r, inList))
    );
  });
}

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

  /**
   * Platform connector template id -> the URL of the template's own icon (`ConnectorTemplateFile.
   * icon`, stored as a catalog display file of the template's current version); templates without
   * one, or that the reader may not see, are absent. The admin scope gets
   * `GET /api/v1/admin/catalog/connector-templates/:templateId/icon` for every live template; an org
   * gets `GET /api/v1/orgs/:orgId/connector-templates/:templateId/icon` only when its catalog shows
   * the template's plugin (the gate of the plugin icon) and the template passes the share gate.
   * The URL carries the template's version (the platform's one version of it).
   */
  async ofTemplates(ids: string[], scope: PluginIconScope): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const rows = (await this.templateRows(ids)).filter((r) => r.iconFile !== undefined);
    for (const r of await this.visibleTemplates(rows, scope)) {
      const url =
        scope.kind === "admin"
          ? `/api/v1/admin/catalog/connector-templates/${enc(r.templateId)}/icon`
          : `/api/v1/orgs/${enc(scope.orgId)}/connector-templates/${enc(r.templateId)}/icon`;
      out.set(r.templateId, `${url}?v=${enc(r.version)}`);
    }
    return out;
  }

  /**
   * The icon of each connector or connector template shown (in the order given): its template's
   * own icon ({@link ofTemplates}), else its plugin's ({@link ofItems}), else null. One lookup
   * each for all rows.
   */
  async ofTemplatesOrItems(
    refs: { templateId: string | null; itemId: string | null }[],
    scope: PluginIconScope,
  ): Promise<(string | null)[]> {
    const nonNull = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);
    const [own, plugin] = await Promise.all([
      this.ofTemplates(nonNull(refs.map((r) => r.templateId)), scope),
      this.ofItems(nonNull(refs.map((r) => r.itemId)), scope),
    ]);
    return refs.map(
      (r) =>
        (r.templateId !== null ? own.get(r.templateId) : undefined) ??
        (r.itemId !== null ? plugin.get(r.itemId) : undefined) ??
        null,
    );
  }

  /**
   * Reads a connector template's own icon (served only through kernel routes with nosniff and a
   * CSP sandbox, like the plugin icon). A template that is unknown, removed or not visible to the
   * reader -> `component.not_found` (decided before any file is read, so "no icon" never reveals
   * that it exists); no icon of its own -> `catalog.icon_not_found`; stored content that is not a
   * valid svg / png (checked at import; this guards against tampered storage) -> `internal`.
   */
  async readTemplateIcon(templateId: string, scope: PluginIconScope): Promise<CatalogIcon> {
    const [row] = await this.visibleTemplates(await this.templateRows([templateId]), scope);
    if (row === undefined) {
      throw new ApiError("component.not_found", "This connector template does not exist");
    }
    if (row.iconFile === undefined) {
      throw new ApiError("catalog.icon_not_found", "This connector template has no icon");
    }
    const [file] = await readCatalogDisplayFiles(this.db, [row.iconFile]);
    if (!file) throw new ApiError("catalog.icon_not_found", "This connector template has no icon");
    const problem = iconProblem(row.iconFile.path, file.data);
    if (problem !== undefined) throw new ApiError("internal", `Stored icon is invalid: ${problem}`);
    return {
      data: file.data,
      contentType: /\.svg$/i.test(row.iconFile.path) ? "image/svg+xml" : "image/png",
    };
  }

  /** Live platform connector templates (of live items) with their item's visibility columns. */
  private async templateRows(ids: string[]) {
    const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
    if (unique.length === 0) return [];
    const rows = await this.db
      .selectFrom("platform_connector_templates as t")
      .innerJoin("catalog_items as i", "i.id", "t.catalog_item_id")
      .innerJoin("catalog_item_versions as v", (j) =>
        j.onRef("v.item_id", "=", "t.catalog_item_id").onRef("v.version", "=", "t.current_version"),
      )
      .select([
        "t.id as template_id",
        "t.owner_org_id as template_owner_org_id",
        "t.shareable as template_shareable",
        "t.current_version",
        sql<string | null>`t.file->>'icon'`.as("icon"),
        "v.files",
        "i.id",
        "i.scope",
        "i.builtin",
        "i.disabled",
        "i.shown_to_others",
        "i.owner_org_id",
        "i.shareable",
        "i.awaiting_confirmation",
      ])
      .where("t.id", "in", unique)
      .where("t.deleted_at", "is", null)
      .where("i.deleted_at", "is", null)
      .execute();
    return rows.map((r) => {
      const path = r.icon === null ? undefined : packagePath(r.icon);
      const files = r.files as { path: string; size: number; sha256: string }[];
      return {
        ...r,
        templateId: r.template_id,
        version: r.current_version,
        iconFile: path === undefined ? undefined : files.find((f) => f.path === path),
      };
    });
  }

  /**
   * The templates the reader may see: every one for the admin scope; for an org, those whose
   * plugin its catalog shows ({@link orgVisibleItems}) and that pass the template's own share gate
   * (the platform's, the org's own, or shared by its owner).
   */
  private async visibleTemplates<
    T extends OrgVisibilityRow & {
      template_owner_org_id: string | null;
      template_shareable: boolean;
    },
  >(rows: T[], scope: PluginIconScope): Promise<T[]> {
    if (scope.kind === "admin") return rows;
    const shared = rows.filter(
      (r) =>
        r.template_owner_org_id === null ||
        r.template_owner_org_id === scope.orgId ||
        r.template_shareable,
    );
    return orgVisibleItems(this.db, shared, scope.orgId, scope.isAdmin);
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
    for (const r of await orgVisibleItems(this.db, withIcon, scope.orgId, scope.isAdmin)) {
      const url = `/api/v1/orgs/${enc(scope.orgId)}/catalog/${enc(r.id)}/icon?v=${enc(r.latest_version)}`;
      out.push({ id: r.id, name: r.name, url });
    }
    return out;
  }
}
