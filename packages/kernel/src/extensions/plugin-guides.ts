import { createHash } from "node:crypto";
import {
  type PluginManifest,
  type PluginSetupGuide,
  renderSetupGuideText,
  SETUP_GUIDE_MODES,
  SETUP_GUIDE_VARIABLES,
  type SetupGuideLanguage,
  type SetupGuidePlace,
  type SetupGuideText,
  setupGuideFileProblem,
  setupGuideModes,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { readCatalogDisplayFiles } from "../catalog/catalog-content.js";
import { webhookBase, webhookUrlOf } from "../channels/webhook-url.js";
import type { GuideAckJson } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { can, type OrgAction, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { orgVisibleItems } from "./plugin-icons.js";

/** The setup guide a channel connection was set up with (`channel_connections.guide_ack`). */
export type GuideAck = GuideAckJson;

/** Where a channel page finds its plugin's guide (`GET /orgs/:orgId/catalog/:itemId/guides/:guideId`). */
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
   * The plugin changed the guide's templates since the connection was set up (its ack): the
   * version acked and the current one; null otherwise (or without an ack).
   */
  guideDrift: { from: string; to: string } | null;
}

/** A guide rendered for an org (spec 2026-11-08-plugin-setup-guides-design.md §4). */
export interface RenderedSetupGuide {
  itemId: string;
  plugin: string;
  version: string;
  id: string;
  place: SetupGuidePlace;
  title: SetupGuideText;
  /** The modes the guide's steps and files use; empty = no mode switch. */
  modes: string[];
  /** The mode rendered (null for a guide without modes and no connection). */
  mode: string | null;
  steps: SetupGuideText[];
  files: {
    title: SetupGuideText;
    language: SetupGuideLanguage;
    fileName: string;
    content: string;
  }[];
  /** Known variables without a value here (left as written, e.g. webhookUrl before saving). */
  unresolved: string[];
  /** The template hash of this mode (what an ack records). */
  hash: string;
}

/** The org action each place's page needs besides `catalog.read`. */
const PLACE_ACTION: Record<SetupGuidePlace, OrgAction> = {
  "channel-connection": "channels.manage",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const guideNotFound = () =>
  new ApiError("catalog.guide_not_found", "The plugin has no such setup guide");

type VersionFile = { path: string; size: number; sha256: string };

/** The items of a guide (steps or files) that apply to a mode: those without one, and its own. */
const forMode = <T extends { mode?: string }>(items: T[] | undefined, mode: string | null): T[] =>
  (items ?? []).filter((x) => x.mode === undefined || x.mode === mode);

/**
 * The template hash of a guide for a mode (spec §6): sha256 over `path NUL sha256 LF` of the files
 * that apply to it, from the version's file list (no storage read). Equal hashes = the same
 * rendered files for the same variables.
 */
export function setupGuideHash(
  guide: PluginSetupGuide,
  files: VersionFile[],
  mode: string | null,
): string {
  const h = createHash("sha256");
  for (const f of forMode(guide.files, mode)) {
    const path = packagePath(f.path);
    h.update(`${path}\0${files.find((x) => x.path === path)?.sha256 ?? "missing"}\n`);
  }
  return h.digest("hex");
}

/** A plugin's guide for a place: its first one there (a plugin normally has one per place). */
const guideOf = (manifest: unknown, place: SetupGuidePlace): PluginSetupGuide | undefined =>
  ((manifest as PluginManifest).setupGuides ?? []).find((g) => g.place === place);

/**
 * Plugin setup guides (spec `2026-11-08-plugin-setup-guides-design.md`): resolves an extension's
 * catalog item (the item of the same name, its latest version), renders a guide's steps and
 * template files with the place's fixed variables (public URLs, names, versions, the mode; never a
 * secret), and computes the template hashes channel connections record to tell when an upgrade
 * changed their setup. Org reads follow the catalog icon's visibility ({@link orgVisibleItems}).
 * Stateless: everything comes from PG (version rows, connection rows, the guide files in
 * `catalog_files`).
 */
@Injectable()
export class PluginGuides {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /** The live items (with their latest version) by name or id. */
  private latest(by: "name" | "id", keys: string[]) {
    return this.db
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

  /**
   * The ack of a plugin's current channel-connection guide for a mode (recorded on a connection
   * when it is created or switches mode); null when the plugin has no catalog item or no guide.
   * Kernel-internal: no org visibility (the connection belongs to the plugin either way).
   */
  async currentAck(plugin: string, mode: string): Promise<GuideAck | null> {
    const [row] = await this.latest("name", [plugin]);
    const guide = row && guideOf(row.manifest, "channel-connection");
    if (!row || !guide) return null;
    return {
      guideId: guide.id,
      version: row.latest_version,
      hash: setupGuideHash(guide, row.files as VersionFile[], mode),
      mode,
    };
  }

  /**
   * Whether an ack is behind the plugin's current guide (the drift rule of spec §6, as the
   * connection pages compute it): the same guide whose templates for the ack's mode changed. False
   * without an ack, a catalog item or the guide. Kernel-internal: no org visibility.
   */
  async ackDrifted(plugin: string, ack: GuideAck | null): Promise<boolean> {
    if (ack === null) return false;
    const current = await this.currentAck(plugin, ack.mode);
    return current !== null && current.guideId === ack.guideId && current.hash !== ack.hash;
  }

  /**
   * Plugin name -> its channel-connection guide, for plugins whose item the org's catalog shows
   * (`GET channels/schema/:plugin` and the connection pages); others are absent.
   */
  async channelGuides(
    names: string[],
    org: { orgId: string; role: OrgRole },
  ): Promise<Map<string, SetupGuideRef & { guide: PluginSetupGuide; files: VersionFile[] }>> {
    const out = new Map<
      string,
      SetupGuideRef & { guide: PluginSetupGuide; files: VersionFile[] }
    >();
    if (names.length === 0) return out;
    const rows = (await this.latest("name", names)).filter(
      (r) => guideOf(r.manifest, "channel-connection") !== undefined,
    );
    const visible = await orgVisibleItems(this.db, rows, org.orgId, roleAtLeast(org.role, "admin"));
    for (const r of visible) {
      const guide = guideOf(r.manifest, "channel-connection") as PluginSetupGuide;
      out.set(r.name, {
        itemId: r.id,
        guideId: guide.id,
        version: r.latest_version,
        guide,
        files: r.files as VersionFile[],
      });
    }
    return out;
  }

  /** The guide fields of channel connections (one query for all; spec §6 for the drift rule). */
  async connectionStates(
    connections: { id: string; plugin: string; guideAck: GuideAck | null }[],
    org: { orgId: string; role: OrgRole },
  ): Promise<Map<string, ConnectionGuideState>> {
    const guides = await this.channelGuides(
      connections.map((c) => c.plugin),
      org,
    );
    const out = new Map<string, ConnectionGuideState>();
    for (const c of connections) {
      const g = guides.get(c.plugin);
      const ack = c.guideAck;
      const drifted =
        g !== undefined &&
        ack !== null &&
        ack.guideId === g.guideId &&
        setupGuideHash(g.guide, g.files, ack.mode) !== ack.hash;
      out.set(c.id, {
        setupGuide: g ? { itemId: g.itemId, guideId: g.guideId, version: g.version } : null,
        guideDrift: drifted ? { from: ack.version, to: g.version } : null,
      });
    }
    return out;
  }

  /**
   * Renders a guide for an org (`GET /orgs/:orgId/catalog/:itemId/guides/:guideId`): the item must
   * be one the org's catalog shows (else `catalog.item_not_found`), the guide one its latest
   * version has (else `catalog.guide_not_found`), and the caller must hold the place's action
   * (`channels.manage` for `channel-connection`, else `forbidden`). `connectionId` (a live
   * connection of the org on this plugin, else `channel.not_found`) supplies the connection's name,
   * webhook URL and default mode; `name` stands in for the name on 新建渠道.
   */
  async render(
    org: { orgId: string; role: OrgRole },
    itemId: string,
    guideId: string,
    q: { mode?: string | undefined; connectionId?: string | undefined; name?: string | undefined },
  ): Promise<RenderedSetupGuide> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const rows = await this.latest("id", [itemId]);
    const [row] = await orgVisibleItems(this.db, rows, org.orgId, roleAtLeast(org.role, "admin"));
    if (!row) throw itemNotFound();
    const guide = ((row.manifest as PluginManifest).setupGuides ?? []).find(
      (g) => g.id === guideId,
    );
    if (!guide) throw guideNotFound();
    if (!can(org.role, PLACE_ACTION[guide.place])) {
      throw new ApiError("forbidden", "Insufficient organization role");
    }
    if (q.mode !== undefined && !SETUP_GUIDE_MODES[guide.place].includes(q.mode)) {
      throw new ApiError("validation_failed", "Request validation failed", [
        {
          path: "mode",
          message: `mode must be one of ${SETUP_GUIDE_MODES[guide.place].join(", ")}`,
        },
      ]);
    }
    const connection =
      q.connectionId === undefined
        ? undefined
        : await this.connection(org.orgId, row.name, q.connectionId);
    const modes = setupGuideModes(guide);
    const mode = q.mode ?? connection?.inbound_mode ?? modes[0] ?? null;

    const cfg = this.config.get();
    const publicUrl = cfg.http.publicUrl?.replace(/\/+$/, "") ?? null;
    const base = webhookBase(cfg);
    const orgRow = await this.db
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", org.orgId)
      .executeTakeFirst();
    const values: Record<string, string | null> = {
      publicUrl,
      webhookUrl: connection && base !== undefined ? webhookUrlOf(base, connection.id) : null,
      signInCallbackUrl:
        publicUrl === null
          ? null
          : `${publicUrl}/api/v1/auth/sso/${encodeURIComponent(row.name)}/callback`,
      connectionName: connection?.name ?? q.name?.trim() ?? null,
      orgName: orgRow?.name ?? null,
      pluginName: row.name,
      pluginVersion: row.latest_version,
      mode,
    };
    if (values.connectionName === "") values.connectionName = null;
    const known = SETUP_GUIDE_VARIABLES[guide.place];
    const unresolved = new Set<string>();
    const render = (text: string, language: SetupGuideLanguage) => {
      const r = renderSetupGuideText(text, values, language, known);
      for (const u of r.unresolved) unresolved.add(u);
      return r.text;
    };
    const localized = (t: SetupGuideText, language: SetupGuideLanguage): SetupGuideText => ({
      en: render(t.en, language),
      ...(t.zh !== undefined && { zh: render(t.zh, language) }),
    });

    const versionFiles = row.files as VersionFile[];
    const selected = forMode(guide.files, mode);
    const metas = selected.map((f) => {
      const path = packagePath(f.path);
      const meta = versionFiles.find((x) => x.path === path);
      // stored at import with the version; a missing one means tampered or lost storage
      if (!meta) throw new ApiError("internal", `Setup guide file ${path} is not stored`);
      return meta;
    });
    const stored = await readCatalogDisplayFiles(this.db, metas);
    const files = selected.map((f) => {
      const path = packagePath(f.path);
      const data = stored.find((x) => x.path === path)?.data;
      const problem = setupGuideFileProblem(path, data);
      if (problem !== undefined) {
        throw new ApiError("internal", `Stored setup guide file is invalid: ${problem}`);
      }
      return {
        title: f.title,
        language: f.language,
        fileName: (path.split("/").pop() as string).replace(/\.tmpl$/i, ""),
        content: render(new TextDecoder().decode(data), f.language),
      };
    });
    return {
      itemId: row.id,
      plugin: row.name,
      version: row.latest_version,
      id: guide.id,
      place: guide.place,
      title: guide.title,
      modes,
      mode,
      steps: forMode(guide.steps, mode).map((s) =>
        localized({ en: s.en, ...(s.zh !== undefined && { zh: s.zh }) }, "text"),
      ),
      files,
      unresolved: known.filter((k) => unresolved.has(k)),
      hash: setupGuideHash(guide, versionFiles, mode),
    };
  }

  /** A live connection of the org on the plugin; otherwise `channel.not_found`. */
  private async connection(orgId: string, plugin: string, id: string) {
    const notFound = () => new ApiError("channel.not_found", "Channel connection not found");
    if (!UUID_RE.test(id)) throw notFound();
    const c = await this.db
      .selectFrom("channel_connections")
      .select(["id", "name", "inbound_mode"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("plugin", "=", plugin)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!c) throw notFound();
    return c;
  }
}
