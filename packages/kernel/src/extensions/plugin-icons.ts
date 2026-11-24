import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  type CatalogIcon,
  readCatalogDisplayFiles,
  readCatalogIcon,
} from "../catalog/catalog-content.js";
import { iconProblem } from "../catalog/plugin-package.js";
import { type PluginScope, requestable } from "../catalog/scope.js";
import { type TemplateDescription, templateDescription } from "../catalog/template-description.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { UUID_RE } from "../ui/registry.js";

/** Who reads the icons: the super admin (admin routes) or one org (its routes, its visibility). */
export type PluginIconScope = { kind: "admin" } | { kind: "org"; orgId: string; isAdmin: boolean };

/** The icon scope of an org route's caller (its org and role). */
export const orgIconScope = (org: {
  orgId: string;
  role: OrgRole;
}): Extract<PluginIconScope, { kind: "org" }> => ({
  kind: "org",
  orgId: org.orgId,
  isAdmin: roleAtLeast(org.role, "admin"),
});

const enc = encodeURIComponent;

/** What a connector or connector template shows an icon for: its platform template and plugin. */
export interface IconRef {
  templateId: string | null;
  itemId: string | null;
}

/** Where a shown icon comes from: a template's own icon or a catalog item's (plugin) icon. */
type IconSource = { kind: "template" | "item"; id: string; version: string };

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
    for (const [id, version] of await this.templateIconVersions(ids, scope)) {
      out.set(id, this.sourceUrl({ kind: "template", id, version }, scope));
    }
    return out;
  }

  /**
   * The icon of each connector template shown (in the order given): its own icon
   * ({@link ofTemplates}), else its plugin's ({@link ofItems}), else null. One lookup each for all
   * rows.
   */
  async ofTemplatesOrItems(refs: IconRef[], scope: PluginIconScope): Promise<(string | null)[]> {
    return (await this.sources(refs, scope)).map((s) => (s ? this.sourceUrl(s, scope) : null));
  }

  /**
   * The icon of each connector template of a catalog item, by template file id (`connectors/<id>.
   * json`, as the item detail lists them): the platform template's own icon, else the plugin's,
   * else null ({@link ofTemplatesOrItems}). A file id without a live platform template gets the
   * plugin's icon.
   */
  async ofItemTemplates(
    itemId: string,
    templateIds: string[],
    scope: PluginIconScope,
  ): Promise<Map<string, string | null>> {
    if (templateIds.length === 0) return new Map();
    const platform = new Map(
      (
        await this.db
          .selectFrom("platform_connector_templates")
          .select(["id", "template_id"])
          .where("catalog_item_id", "=", itemId)
          .where("template_id", "in", [...new Set(templateIds)])
          .where("deleted_at", "is", null)
          .execute()
      ).map((r) => [r.template_id, r.id]),
    );
    const urls = await this.ofTemplatesOrItems(
      templateIds.map((t) => ({ templateId: platform.get(t) ?? null, itemId })),
      scope,
    );
    return new Map(templateIds.map((t, i) => [t, urls[i] ?? null]));
  }

  /**
   * The icon of each of an org's connectors (in the order given), resolved as
   * {@link ofTemplatesOrItems} (its platform template's own icon, else its plugin's, else null)
   * but always served by the connector's own route, `GET /api/v1/orgs/:orgId/connectors/:id/icon`
   * (`connectors.use`, see {@link readConnectorIcon}): everyone who sees the connector pages,
   * guests included, can load it, while the catalog's icon route stays `catalog.read`. The URL
   * carries where the icon comes from and its version, so a new icon is not stale-cached.
   */
  async ofConnectors(
    rows: (IconRef & { id: string })[],
    scope: Extract<PluginIconScope, { kind: "org" }>,
  ): Promise<(string | null)[]> {
    const sources = await this.sources(rows, scope);
    return rows.map((r, i) => {
      const s = sources[i];
      if (!s) return null;
      const v = `${s.kind === "template" ? "t" : "p"}-${s.version}`;
      return `/api/v1/orgs/${enc(scope.orgId)}/connectors/${enc(r.id)}/icon?v=${enc(v)}`;
    });
  }

  /**
   * Platform connector template id -> its description (the template file's current version,
   * {@link templateDescription}), for the templates the reader may see under the same gate as
   * their own icons ({@link ofTemplates}); templates without one, or hidden, are absent. The
   * connector pages show it for connectors made from a template.
   */
  async templateDescriptions(
    ids: string[],
    scope: PluginIconScope,
  ): Promise<Map<string, TemplateDescription>> {
    const out = new Map<string, TemplateDescription>();
    for (const r of await this.visibleTemplates(await this.templateRows(ids), scope)) {
      const d = templateDescription(r.description);
      if (d.description !== null) out.set(r.templateId, d);
    }
    return out;
  }

  /**
   * Reads the icon a connector shows ({@link ofConnectors}); the caller has checked that the
   * connector is the org's. No icon the reader may see -> `catalog.icon_not_found`.
   */
  async readConnectorIcon(ref: IconRef, scope: PluginIconScope): Promise<CatalogIcon> {
    const [s] = await this.sources([ref], scope);
    if (!s) throw new ApiError("catalog.icon_not_found", "This connector has no icon");
    if (s.kind === "template") return this.readTemplateIcon(s.id, scope);
    // the item's visibility was decided above (the same gate as the plugin icon route)
    return readCatalogIcon(this.db.db, s.id, true);
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

  /** Where each ref's icon comes from: its template's own icon, else its plugin's, else none. */
  private async sources(refs: IconRef[], scope: PluginIconScope): Promise<(IconSource | null)[]> {
    const nonNull = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);
    const [own, plugin] = await Promise.all([
      this.templateIconVersions(nonNull(refs.map((r) => r.templateId)), scope),
      this.resolve("id", nonNull(refs.map((r) => r.itemId)), scope),
    ]);
    const items = new Map(plugin.map((i) => [i.id, i.version]));
    return refs.map((r): IconSource | null => {
      const tv = r.templateId !== null ? own.get(r.templateId) : undefined;
      if (r.templateId !== null && tv !== undefined) {
        return { kind: "template", id: r.templateId, version: tv };
      }
      const iv = r.itemId !== null ? items.get(r.itemId) : undefined;
      return r.itemId !== null && iv !== undefined
        ? { kind: "item", id: r.itemId, version: iv }
        : null;
    });
  }

  /** The URL of an icon source on the reader's routes (template or catalog item route). */
  private sourceUrl(s: IconSource, scope: PluginIconScope): string {
    const path =
      s.kind === "template"
        ? scope.kind === "admin"
          ? `/api/v1/admin/catalog/connector-templates/${enc(s.id)}/icon`
          : `/api/v1/orgs/${enc(scope.orgId)}/connector-templates/${enc(s.id)}/icon`
        : scope.kind === "admin"
          ? `/api/v1/admin/catalog/items/${enc(s.id)}/icon`
          : `/api/v1/orgs/${enc(scope.orgId)}/catalog/${enc(s.id)}/icon`;
    return `${path}?v=${enc(s.version)}`;
  }

  /** Template id -> its version, for the templates with an own icon the reader may see. */
  private async templateIconVersions(
    ids: string[],
    scope: PluginIconScope,
  ): Promise<Map<string, string>> {
    const rows = (await this.templateRows(ids)).filter((r) => r.iconFile !== undefined);
    return new Map(
      (await this.visibleTemplates(rows, scope)).map((r) => [r.templateId, r.version]),
    );
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
        sql<unknown>`t.file->'description'`.as("description"),
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
  ): Promise<{ id: string; name: string; url: string; version: string }[]> {
    const out: { id: string; name: string; url: string; version: string }[] = [];
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
        out.push({ id: r.id, name: r.name, url, version: r.latest_version });
      }
      return out;
    }
    for (const r of await orgVisibleItems(this.db, withIcon, scope.orgId, scope.isAdmin)) {
      const url = `/api/v1/orgs/${enc(scope.orgId)}/catalog/${enc(r.id)}/icon?v=${enc(r.latest_version)}`;
      out.push({ id: r.id, name: r.name, url, version: r.latest_version });
    }
    return out;
  }
}
