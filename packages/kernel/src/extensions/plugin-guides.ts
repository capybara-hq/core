import {
  type PluginSetupGuide,
  renderSetupGuide,
  SETUP_GUIDE_PLACE_INFO,
  SETUP_GUIDE_PLACES,
  type SetupGuideAudience,
  type SetupGuideBlock,
  type SetupGuidePlace,
  setupGuideDocPath,
  setupGuideDocProblem,
  setupGuideHash,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { readCatalogDisplayFiles } from "../catalog/catalog-content.js";
import type { GuideAckJson } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { can, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import {
  type GuideTarget,
  type GuideTargetQuery,
  PLACE_ACTIONS,
  type PlaceResolution,
  resolvePlace,
  type UnresolvedReason,
} from "./guide-places.js";
import { orgVisibleItems } from "./plugin-icons.js";

export { PLACE_ACTIONS, type UnresolvedReason } from "./guide-places.js";

/**
 * The setup guide a target was set up with (`channel_connections.guide_ack`): the guide, the
 * plugin version, the drift hash of the admin audience and the mode (null for a place without
 * modes).
 */
export type GuideAck = GuideAckJson;

/** Where a page finds its plugin's guide (`GET /orgs/:orgId/catalog/:itemId/guides/:guideId`). */
export interface SetupGuideRef {
  itemId: string;
  guideId: string;
  /** The item's latest version (the guide's). */
  version: string;
}

/** The guide fields of a channel connection page. */
export interface ConnectionGuideState {
  /** The plugin's channel-connection guide the org may see, null without one. */
  setupGuide: SetupGuideRef | null;
  /**
   * The plugin changed the guide's code blocks or checks for the ack's mode since the connection
   * was set up (its ack): the version acked and the current one; null otherwise (or without an
   * ack).
   */
  guideDrift: { from: string; to: string } | null;
}

/** A guide rendered for an org or the platform (spec 2026-11-09-setup-guides-v2-design.md §7.2). */
export interface RenderedSetupGuide {
  itemId: string;
  plugin: string;
  version: string;
  id: string;
  place: SetupGuidePlace;
  /** The document rendered (zh falls back to en). */
  locale: "en" | "zh";
  title: string;
  /** The modes the document's sections use; empty = no mode switch. */
  modes: string[];
  /** The mode rendered; null for a place without modes. */
  mode: string | null;
  /** The audiences the document has sections for. */
  audiences: SetupGuideAudience[];
  audience: SetupGuideAudience;
  blocks: SetupGuideBlock[];
  /** The check rows, in document order. */
  checks: { id: string; label: string; source: "plugin" | "kernel" }[];
  /** Known variables the rendered text uses without a value (left as written), with why. */
  unresolved: { name: string; reason: UnresolvedReason }[];
  /** The drift hash of this mode and audience (what an ack records). */
  hash: string;
  target: GuideTarget | null;
}

/** The query of the guide route. */
export interface GuideQuery extends GuideTargetQuery {
  mode?: string | undefined;
  audience?: SetupGuideAudience | undefined;
  locale?: "en" | "zh" | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUIDE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GUIDE_KEYS = new Set(["id", "place", "template"]);
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const guideNotFound = () =>
  new ApiError("catalog.guide_not_found", "The plugin has no such setup guide");
const invalidQuery = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

type VersionFile = { path: string; size: number; sha256: string };

/** The live items (with their latest version) by name or id. */
function latestItems(db: KernelDb, by: "name" | "id", keys: string[]) {
  return db
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
      "v.manifest",
      "v.files",
    ])
    .where(by === "name" ? "i.name" : "i.id", "in", [...new Set(keys)])
    .where("i.deleted_at", "is", null)
    .execute();
}

/** A live item with its latest version, as {@link PluginGuides} reads it. */
export type ItemRow = Awaited<ReturnType<typeof latestItems>>[number];

/** Whether a stored `setupGuides` entry is a v2 one (the SDK's strict shape). */
function isV2Guide(g: unknown): g is PluginSetupGuide {
  if (typeof g !== "object" || g === null || Array.isArray(g)) return false;
  const o = g as Record<string, unknown>;
  return (
    Object.keys(o).every((k) => GUIDE_KEYS.has(k)) &&
    typeof o.id === "string" &&
    GUIDE_ID_RE.test(o.id) &&
    (SETUP_GUIDE_PLACES as readonly unknown[]).includes(o.place) &&
    (o.template === undefined || (typeof o.template === "string" && GUIDE_ID_RE.test(o.template)))
  );
}

/**
 * A version's v2 guides and the entries skipped: a version imported before setup guides v2 keeps
 * v1-shaped entries, which render no guide (spec §15; not a compatibility layer).
 */
function guidesOf(manifest: unknown): { guides: PluginSetupGuide[]; skipped: number } {
  const raw = (manifest as { setupGuides?: unknown }).setupGuides;
  if (!Array.isArray(raw)) return { guides: [], skipped: 0 };
  const guides = raw.filter(isV2Guide);
  return { guides, skipped: raw.length - guides.length };
}

/** A plugin's guide for a place (and template): the manifest allows at most one. */
const guideFor = (manifest: unknown, place: SetupGuidePlace, templateId?: string) =>
  guidesOf(manifest).guides.find(
    (g) => g.place === place && (templateId === undefined || g.template === templateId),
  );

/** The stored file of a guide document, or undefined when the version has none. */
const docMeta = (row: { files: unknown }, id: string, locale: "en" | "zh") => {
  const path = setupGuideDocPath(id, locale);
  return (row.files as VersionFile[]).find((f) => f.path === path);
};

/**
 * Plugin setup guides v2 (spec `2026-11-09-setup-guides-v2-design.md`): resolves an extension's
 * catalog item (the item of the same name, its latest version), renders a guide document for a
 * place, audience, mode and target with the place's safe variables (`guide-places.ts`; never a
 * secret), and computes the drift hashes targets record to tell when an upgrade changed their
 * setup. Org reads follow the catalog icon's visibility ({@link orgVisibleItems}), the platform
 * preview any live item. Stateless: everything comes from PG (version rows, target rows, the
 * documents in `catalog_files`).
 */
@Injectable()
export class PluginGuides {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  private latest(by: "name" | "id", keys: string[]) {
    return latestItems(this.db, by, keys);
  }

  /** The English documents of guides, by `<itemId>/<guideId>` (one PG read); absent when not stored. */
  private async englishSources(
    pairs: { row: ItemRow; guide: PluginSetupGuide }[],
  ): Promise<Map<string, string>> {
    const metas = pairs.flatMap(({ row, guide }) => {
      const meta = docMeta(row, guide.id, "en");
      return meta === undefined ? [] : [{ key: `${row.id}/${guide.id}`, meta }];
    });
    const out = new Map<string, string>();
    if (metas.length === 0) return out;
    const files = await readCatalogDisplayFiles(
      this.db,
      metas.map((m) => m.meta),
    );
    metas.forEach((m, i) => {
      const data = files[i]?.data;
      if (data !== undefined && setupGuideDocProblem(m.meta.path, data) === undefined) {
        out.set(m.key, new TextDecoder().decode(data));
      }
    });
    return out;
  }

  /** The admin drift hash of a guide for a mode. */
  private static hashOf(enSource: string, guide: PluginSetupGuide, mode: string | null): string {
    return setupGuideHash(enSource, {
      place: guide.place,
      guideId: guide.id,
      mode,
      audience: "admin",
    });
  }

  /**
   * The ack of a plugin's current guide for a place (and template) and mode, admin audience:
   * recorded on a target when it is created or switches mode. Null when the plugin has no catalog
   * item, no such guide or no stored document. Kernel-internal: no org visibility (the target
   * belongs to the plugin either way).
   */
  async currentAck(
    plugin: string,
    place: SetupGuidePlace,
    o: { mode: string | null; templateId?: string },
  ): Promise<GuideAck | null> {
    const [row] = await this.latest("name", [plugin]);
    const guide = row && guideFor(row.manifest, place, o.templateId);
    if (!row || !guide) return null;
    const en = (await this.englishSources([{ row, guide }])).get(`${row.id}/${guide.id}`);
    if (en === undefined) return null;
    return {
      guideId: guide.id,
      version: row.latest_version,
      hash: PluginGuides.hashOf(en, guide, o.mode),
      mode: o.mode,
    };
  }

  /**
   * Whether an ack is behind the plugin's current guide (spec §11): the same guide whose hash for
   * the ack's mode changed. False without an ack, a catalog item or the guide. Kernel-internal: no
   * org visibility.
   */
  async ackDrifted(
    plugin: string,
    place: SetupGuidePlace,
    ack: GuideAck | null,
    o: { templateId?: string } = {},
  ): Promise<boolean> {
    if (ack === null) return false;
    const current = await this.currentAck(plugin, place, {
      mode: ack.mode,
      ...(o.templateId !== undefined && { templateId: o.templateId }),
    });
    return current !== null && current.guideId === ack.guideId && current.hash !== ack.hash;
  }

  /**
   * Plugin name -> its channel-connection guide, for plugins whose item the org's catalog shows
   * (`GET channels/schema/:plugin` and the connection pages); others are absent.
   */
  async channelGuides(
    names: string[],
    org: { orgId: string; role: OrgRole },
  ): Promise<Map<string, SetupGuideRef & { guide: PluginSetupGuide; row: ItemRow }>> {
    const out = new Map<string, SetupGuideRef & { guide: PluginSetupGuide; row: ItemRow }>();
    if (names.length === 0) return out;
    const rows = (await this.latest("name", names)).filter(
      (r) => guideFor(r.manifest, "channel-connection") !== undefined,
    );
    const visible = await orgVisibleItems(this.db, rows, org.orgId, roleAtLeast(org.role, "admin"));
    for (const r of visible) {
      const guide = guideFor(r.manifest, "channel-connection") as PluginSetupGuide;
      out.set(r.name, {
        itemId: r.id,
        guideId: guide.id,
        version: r.latest_version,
        guide,
        row: r,
      });
    }
    return out;
  }

  /** The guide fields of channel connections (one query each for guides and documents; spec §11). */
  async connectionStates(
    connections: { id: string; plugin: string; guideAck: GuideAck | null }[],
    org: { orgId: string; role: OrgRole },
  ): Promise<Map<string, ConnectionGuideState>> {
    const guides = await this.channelGuides(
      connections.map((c) => c.plugin),
      org,
    );
    // documents only for the guides an ack is compared with
    const compared = [
      ...new Set(
        connections
          .filter(
            (c) => c.guideAck !== null && guides.get(c.plugin)?.guideId === c.guideAck.guideId,
          )
          .map((c) => c.plugin),
      ),
    ].map((p) => guides.get(p) as SetupGuideRef & { guide: PluginSetupGuide; row: ItemRow });
    const sources = await this.englishSources(compared);
    const out = new Map<string, ConnectionGuideState>();
    for (const c of connections) {
      const g = guides.get(c.plugin);
      const ack = c.guideAck;
      const en = g && sources.get(`${g.itemId}/${g.guideId}`);
      const drifted =
        g !== undefined &&
        en !== undefined &&
        ack !== null &&
        ack.guideId === g.guideId &&
        PluginGuides.hashOf(en, g.guide, ack.mode) !== ack.hash;
      out.set(c.id, {
        setupGuide: g ? { itemId: g.itemId, guideId: g.guideId, version: g.version } : null,
        guideDrift: drifted ? { from: ack.version, to: g.version } : null,
      });
    }
    return out;
  }

  /**
   * The documents of a guide of an item's latest version (no visibility check: callers check it):
   * the source in `locale` (falling back to English), the English source (hashes, check lookup) and
   * the locale actually read. 404 `catalog.item_not_found` / `catalog.guide_not_found`.
   */
  async loadDocument(
    itemId: string,
    guideId: string,
    locale: "en" | "zh",
  ): Promise<{
    row: ItemRow;
    guide: PluginSetupGuide;
    source: string;
    enSource: string;
    locale: "en" | "zh";
  }> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const [row] = await this.latest("id", [itemId]);
    if (!row) throw itemNotFound();
    const guide = guidesOf(row.manifest).guides.find((g) => g.id === guideId);
    if (!guide) throw guideNotFound();
    return { row, guide, ...(await this.documents(row, guide, locale)) };
  }

  /** Reads and checks a guide's stored documents (one PG read). */
  private async documents(
    row: ItemRow,
    guide: PluginSetupGuide,
    locale: "en" | "zh",
  ): Promise<{ source: string; enSource: string; locale: "en" | "zh" }> {
    const en = docMeta(row, guide.id, "en");
    // stored at import with the version; a missing one means tampered or lost storage
    if (en === undefined) {
      throw new ApiError(
        "internal",
        `Setup guide document ${setupGuideDocPath(guide.id, "en")} is not stored`,
      );
    }
    const zh = locale === "zh" ? docMeta(row, guide.id, "zh") : undefined;
    const files = await readCatalogDisplayFiles(this.db, zh === undefined ? [en] : [en, zh]);
    const text = (f: (typeof files)[number] | undefined, path: string) => {
      const problem = setupGuideDocProblem(path, f?.data);
      if (problem !== undefined) {
        throw new ApiError("internal", `Stored setup guide document is invalid: ${problem}`);
      }
      return new TextDecoder().decode(f?.data);
    };
    const enSource = text(files[0], en.path);
    if (zh === undefined) return { source: enSource, enSource, locale: "en" };
    return { source: text(files[1], zh.path), enSource, locale: "zh" };
  }

  /** Logs the stored guide entries a version skips (once per render). */
  private warnSkipped(row: ItemRow): void {
    const { skipped } = guidesOf(row.manifest);
    if (skipped > 0) {
      this.log.warn("setup guide entries skipped: not in the v2 format (update the plugin)", {
        plugin: row.name,
        version: row.latest_version,
        skipped,
      });
    }
  }

  /**
   * Renders a guide for an org (`GET /orgs/:orgId/catalog/:itemId/guides/:guideId`): the item must
   * be one the org's catalog shows (else `catalog.item_not_found`), the guide one its latest
   * version has (else `catalog.guide_not_found`), `mode` and `audience` the place's (else
   * `validation_failed`), and the caller must hold the place and audience's action
   * ({@link PLACE_ACTIONS}, else `forbidden`). The target parameters are the place's
   * (`guide-places.ts`): a target must be a live object of the org on the plugin, else 404.
   */
  async render(
    org: { orgId: string; role: OrgRole },
    itemId: string,
    guideId: string,
    q: GuideQuery,
  ): Promise<RenderedSetupGuide> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const rows = await this.latest("id", [itemId]);
    const [row] = await orgVisibleItems(this.db, rows, org.orgId, roleAtLeast(org.role, "admin"));
    if (!row) throw itemNotFound();
    this.warnSkipped(row);
    const guide = guidesOf(row.manifest).guides.find((g) => g.id === guideId);
    if (!guide) throw guideNotFound();
    const audience = this.checkQuery(guide, q);
    const action = PLACE_ACTIONS[guide.place][audience];
    if (action === undefined || !can(org.role, action)) {
      throw new ApiError("forbidden", "Insufficient organization role");
    }
    const docs = await this.documents(row, guide, q.locale ?? "en");
    const orgRow = await this.db
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", org.orgId)
      .executeTakeFirst();
    const resolution = await resolvePlace({
      db: this.db,
      config: this.config.get(),
      item: { id: row.id, name: row.name, version: row.latest_version },
      guide,
      locale: docs.locale,
      org: { orgId: org.orgId, name: orgRow?.name ?? "" },
      query: { connectionId: q.connectionId, name: q.name, connectorId: q.connectorId },
    });
    return this.renderDoc(row, guide, docs, resolution, { mode: q.mode, audience });
  }

  /**
   * Renders a guide for the platform (the super admin's preview, `GET /admin/catalog/:itemId/guides/
   * :guideId`): any live item, the admin audience, no org (`orgName` unresolved) and no target.
   */
  async renderForPlatform(
    itemId: string,
    guideId: string,
    q: { locale?: "en" | "zh" | undefined },
  ): Promise<RenderedSetupGuide> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const [row] = await this.latest("id", [itemId]);
    if (!row) throw itemNotFound();
    this.warnSkipped(row);
    const guide = guidesOf(row.manifest).guides.find((g) => g.id === guideId);
    if (!guide) throw guideNotFound();
    const docs = await this.documents(row, guide, q.locale ?? "en");
    const resolution = await resolvePlace({
      db: this.db,
      config: this.config.get(),
      item: { id: row.id, name: row.name, version: row.latest_version },
      guide,
      locale: docs.locale,
      org: null,
      query: {},
    });
    return this.renderDoc(row, guide, docs, resolution, { mode: undefined, audience: "admin" });
  }

  /** The audience asked for, after checking `mode` and `audience` against the place. */
  private checkQuery(guide: PluginSetupGuide, q: GuideQuery): SetupGuideAudience {
    const info = SETUP_GUIDE_PLACE_INFO[guide.place];
    const audience = q.audience ?? "admin";
    if (!info.audiences.includes(audience)) {
      throw invalidQuery(
        "audience",
        `audience must be one of ${info.audiences.join(", ")} for a ${guide.place} guide`,
      );
    }
    if (q.mode !== undefined && !info.modes.includes(q.mode)) {
      throw invalidQuery(
        "mode",
        info.modes.length === 0
          ? `a ${guide.place} guide has no modes`
          : `mode must be one of ${info.modes.join(", ")}`,
      );
    }
    return audience;
  }

  /** The rendered guide: the mode picked, the document rendered, the hash and the reasons. */
  private renderDoc(
    row: ItemRow,
    guide: PluginSetupGuide,
    docs: { source: string; enSource: string; locale: "en" | "zh" },
    resolution: PlaceResolution,
    o: { mode: string | undefined; audience: SetupGuideAudience },
  ): RenderedSetupGuide {
    const info = SETUP_GUIDE_PLACE_INFO[guide.place];
    // the asked mode, else the target's stored one, else the place's first (spec §8)
    const mode =
      info.modes.length === 0 ? null : (o.mode ?? resolution.storedMode ?? info.modes[0] ?? null);
    const doc = renderSetupGuide(docs.source, {
      place: guide.place,
      mode,
      audience: o.audience,
      values: { ...resolution.values, mode },
    });
    return {
      itemId: row.id,
      plugin: row.name,
      version: row.latest_version,
      id: guide.id,
      place: guide.place,
      locale: docs.locale,
      title: doc.title,
      modes: doc.modes,
      mode,
      audiences: doc.audiences,
      audience: o.audience,
      blocks: doc.blocks,
      checks: doc.checks,
      // `mode` without a value (a place without modes) has no reason anyone can act on
      unresolved: doc.unresolved.flatMap((name) => {
        const reason = resolution.reasons[name];
        return reason === undefined ? [] : [{ name, reason }];
      }),
      hash: setupGuideHash(docs.enSource, {
        place: guide.place,
        guideId: guide.id,
        mode,
        audience: o.audience,
      }),
      target: resolution.target,
    };
  }
}
