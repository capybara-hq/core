import type { SetupGuideAudience, SetupGuideBlock, SetupGuidePlace } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ComponentScopeService } from "../catalog/component-scope.service.js";
import { ApiError } from "../errors.js";
import {
  type ConnectionGuideState,
  type GuideQuery,
  PluginGuides,
  type RenderedSetupGuide,
  type UnresolvedReason,
} from "../extensions/plugin-guides.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { can, type OrgRole } from "../orgs/roles.js";
import type { SetupCheckState } from "./setup-check-registry.js";
import { type CheckCaller, SetupChecksService } from "./setup-checks.service.js";

/** The cached check states of one target, counted (`running` while a run holds the lock). */
export interface SetupCheckSummary {
  ok: number;
  failing: number;
  unknown: number;
  running: number;
  notRun: number;
}

/** Something a guide is for: a channel connection, a connector, or a template without one yet. */
export interface SetupGuideTarget {
  kind: "channel-connection" | "connector" | "connector-template";
  /** The connection or connector id; the template id for `connector-template`. */
  id: string;
  name: string;
  /** The guide changed since the target was set up (its ack): the versions; null otherwise. */
  drift: { from: string; to: string } | null;
  /** Null when there is nothing to check yet (a template without a connector) or it is unreadable. */
  checks: SetupCheckSummary | null;
  /** The web page where the person does this setup (enters values, acks the guide). */
  webPath: string;
}

/** One guide the caller may see in the org, with its targets (`GET /orgs/:orgId/setup-guides`). */
export interface SetupGuideListEntry {
  itemId: string;
  plugin: string;
  guideId: string;
  place: SetupGuidePlace;
  /** The connector template of a `connector-template` guide; null for other places. */
  template: string | null;
  /** The section rendered: org admins get the admin guides, members their member sections. */
  audience: SetupGuideAudience;
  title: string;
  targets: SetupGuideTarget[];
}

/** A rendered guide as one Markdown document, for an agent assisting the person (`setup.read`). */
export interface SetupGuideDocument {
  itemId: string;
  plugin: string;
  guideId: string;
  place: SetupGuidePlace;
  title: string;
  /** Blocks joined; checks as `- [check <id>] <label>` lines. */
  markdown: string;
  modes: string[];
  mode: string | null;
  audiences: SetupGuideAudience[];
  audience: SetupGuideAudience;
  checks: { id: string; label: string }[];
  unresolved: { name: string; reason: UnresolvedReason }[];
  target: { kind: "channel-connection" | "connector"; id: string } | null;
  webPath: string;
  /** What stays with the person, and where they do it. */
  handover: string;
}

const enc = encodeURIComponent;

/** The web page of a target (`apps/web` routes; the guide sections live there). */
export const setupWebPath = {
  connection: (id: string) => `/channels/${enc(id)}`,
  newConnection: () => "/channels/new",
  connector: (id: string) => `/connectors/${enc(id)}?tab=guide`,
  /** A member's connector section: the connector's row on their connections page (§9.3). */
  memberConnections: () => "/account/connections",
  template: (itemId: string) => `/connectors/install?template=${enc(itemId)}`,
};

/**
 * The page a rendered guide belongs on: a member's connections page for the member audience, else
 * its target's, else where a target is created.
 */
function webPathOf(g: RenderedSetupGuide): string {
  if (g.audience === "member") return setupWebPath.memberConnections();
  if (g.target?.kind === "channel-connection") return setupWebPath.connection(g.target.id);
  if (g.target?.kind === "connector") return setupWebPath.connector(g.target.id);
  return g.place === "channel-connection"
    ? setupWebPath.newConnection()
    : setupWebPath.template(g.itemId);
}

/** A fence longer than any run of backticks in the text. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The blocks of a rendered guide as one Markdown document (checks as `- [check <id>]` lines). */
export function guideMarkdown(title: string, blocks: readonly SetupGuideBlock[]): string {
  const parts = [`# ${title}`];
  for (const b of blocks) {
    if (b.kind === "markdown") parts.push(b.text.trimEnd());
    else if (b.kind === "check") parts.push(`- [check ${b.id}] ${b.label}`);
    else {
      const fence = fenceFor(b.text);
      const code = `${fence}${b.language}\n${b.text.replace(/\n$/, "")}\n${fence}`;
      parts.push(b.title === null ? code : `**${b.title}**\n\n${code}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

function summarize(states: Record<string, SetupCheckState>): SetupCheckSummary {
  const out: SetupCheckSummary = { ok: 0, failing: 0, unknown: 0, running: 0, notRun: 0 };
  for (const s of Object.values(states)) {
    if (s.status === "ok") out.ok += 1;
    else if (s.status === "failing") out.failing += 1;
    else if (s.status === "running") out.running += 1;
    else if (s.status === "not_run") out.notRun += 1;
    else out.unknown += 1;
  }
  return out;
}

/** A guide target before rendering: what to render it for and how it is shown. */
interface Pending {
  itemId: string;
  guideId: string;
  audience: SetupGuideAudience;
  query: GuideQuery;
  target: Omit<SetupGuideTarget, "checks"> & { checked: boolean };
}

/**
 * The setup guides of an org as a person sees them (spec 2026-11-09-setup-guides-v2-design.md §12:
 * `GET /orgs/:orgId/setup-guides`, the `Platform` tool's `setup.guides` and `setup.read`). Nothing
 * new is decided here: guides, visibility, drift and actions are `PluginGuides`' (the guide route's
 * rules), check states are `SetupChecksService.states` (cached, nothing runs), the templates on in
 * the org are `ComponentScopeService.orgList`'s. Rendered text carries no secret (§6.3) and check
 * states only their fixed, redacted fields (§10.8). Stateless: everything comes from PG and Redis.
 */
@Injectable()
export class SetupGuidesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(PluginGuides)
    private readonly guides: Pick<PluginGuides, "render" | "connectionStates" | "connectorStates">,
    @Inject(SetupChecksService) private readonly checks: Pick<SetupChecksService, "states">,
    @Inject(ComponentScopeService)
    private readonly components: Pick<ComponentScopeService, "orgList">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * The guides the caller may see, each with its targets: org admins (`channels.manage`) the
   * channel connections; org admins (`connectors.manage`) the connectors made from templates and
   * the templates on in the org without a connector, admin audience; members (`connectors.use`
   * without `connectors.manage`) the connectors whose template guide has a member section, member
   * audience, without drift (only an admin acks). Each target carries its cached check summary.
   * A guide that cannot be rendered (gone, a stored document unreadable) is left out and logged.
   */
  async list(
    caller: CheckCaller,
    q: { locale?: "en" | "zh" | undefined } = {},
  ): Promise<SetupGuideListEntry[]> {
    const org = { orgId: caller.orgId, role: caller.role };
    const pending = [
      ...(can(caller.role, "channels.manage") ? await this.connections(org) : []),
      ...(await this.connectors(org)),
    ];
    const entries = new Map<string, SetupGuideListEntry>();
    for (const p of pending) {
      const key = `${p.itemId}/${p.guideId}/${p.audience}`;
      let entry = entries.get(key);
      if (entry === undefined) {
        const g = await this.renderOrSkip(org, p.itemId, p.guideId, {
          audience: p.audience,
          locale: q.locale ?? "en",
        });
        // members get a guide only when it has a member section (the web's How to connect rule, §9.3);
        // text outside every section applies to all audiences, so admins need no section
        if (g === null || (p.audience === "member" && !g.audiences.includes("member"))) continue;
        entry = {
          itemId: g.itemId,
          plugin: g.plugin,
          guideId: g.id,
          place: g.place,
          template: g.template,
          audience: p.audience,
          title: g.title,
          targets: [],
        };
        entries.set(key, entry);
      }
      const { checked, ...target } = p.target;
      entry.targets.push({
        ...target,
        checks: checked ? await this.summary(caller, p) : null,
      });
    }
    return [...entries.values()];
  }

  /** The cached check summary of a target, or null when the guide cannot be read for it. */
  private async summary(caller: CheckCaller, p: Pending): Promise<SetupCheckSummary | null> {
    try {
      return summarize(
        await this.checks.states(caller, p.itemId, p.guideId, {
          audience: p.audience,
          connectionId: p.query.connectionId,
          connectorId: p.query.connectorId,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) return null;
      throw err;
    }
  }

  private async renderOrSkip(
    org: { orgId: string; role: OrgRole },
    itemId: string,
    guideId: string,
    q: GuideQuery,
  ): Promise<RenderedSetupGuide | null> {
    try {
      return await this.guides.render(org, itemId, guideId, q);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      this.log.warn("setup guide left out of the list", { itemId, guideId, code: err.code });
      return null;
    }
  }

  /** The org's channel connections whose plugin has a guide the org sees. */
  private async connections(org: { orgId: string; role: OrgRole }): Promise<Pending[]> {
    const rows = await this.db
      .selectFrom("channel_connections")
      .select(["id", "plugin", "name", "guide_ack"])
      .where("org_id", "=", org.orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const states = await this.guides.connectionStates(
      rows.map((r) => ({ id: r.id, plugin: r.plugin, guideAck: r.guide_ack ?? null })),
      org,
    );
    return rows.flatMap((r) =>
      pendingOf(states.get(r.id), "admin", {
        kind: "channel-connection",
        id: r.id,
        name: r.name,
        query: { connectionId: r.id },
        webPath: setupWebPath.connection(r.id),
      }),
    );
  }

  /**
   * The org's connectors made from a template with a guide; for org admins also the templates on
   * in the org that have a guide and no connector yet.
   */
  private async connectors(org: { orgId: string; role: OrgRole }): Promise<Pending[]> {
    const admin = can(org.role, "connectors.manage");
    if (!admin && !can(org.role, "connectors.use")) return [];
    const audience: SetupGuideAudience = admin ? "admin" : "member";
    const rows = await this.db
      .selectFrom("connectors as c")
      .leftJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
      .select([
        "c.id",
        "c.name",
        "c.guide_ack",
        "c.platform_template_id",
        "t.catalog_item_id",
        "t.template_id",
      ])
      .where("c.org_id", "=", org.orgId)
      .where("c.deleted_at", "is", null)
      .orderBy("c.created_at")
      .orderBy("c.id")
      .execute();
    const states = await this.guides.connectorStates(
      rows.map((r) => ({
        id: r.id,
        itemId: r.catalog_item_id ?? null,
        templateId: r.template_id ?? null,
        guideAck: r.guide_ack ?? null,
      })),
      org,
    );
    const out = rows.flatMap((r) => {
      const state = states.get(r.id);
      return pendingOf(state && (admin ? state : { ...state, guideDrift: null }), audience, {
        kind: "connector",
        id: r.id,
        name: r.name,
        query: { connectorId: r.id },
        webPath: admin ? setupWebPath.connector(r.id) : setupWebPath.memberConnections(),
      });
    });
    if (!admin) return out;
    const made = new Set(
      rows.flatMap((r) => (r.platform_template_id ? [r.platform_template_id] : [])),
    );
    const templates = await this.components.orgList(org.orgId, { kind: "connector_template" });
    for (const t of templates) {
      if (!t.on || made.has(t.id) || !t.guide || t.itemId === null) continue;
      out.push({
        itemId: t.guide.itemId,
        guideId: t.guide.guideId,
        audience,
        query: {},
        target: {
          kind: "connector-template",
          id: t.name,
          name: t.displayName?.en ?? t.name,
          drift: null,
          webPath: setupWebPath.template(t.itemId),
          checked: false,
        },
      });
    }
    return out;
  }

  /**
   * One guide rendered for the caller as a Markdown document (`setup.read`): the guide route's
   * rendering (`PluginGuides.render`, its visibility, action and target rules), joined, with the
   * page where the person enters values and acks.
   */
  async read(
    caller: CheckCaller,
    itemId: string,
    guideId: string,
    q: GuideQuery,
  ): Promise<SetupGuideDocument> {
    const g = await this.guides.render(
      { orgId: caller.orgId, role: caller.role },
      itemId,
      guideId,
      q,
    );
    const webPath = webPathOf(g);
    return {
      itemId: g.itemId,
      plugin: g.plugin,
      guideId: g.id,
      place: g.place,
      title: g.title,
      markdown: guideMarkdown(g.title, g.blocks),
      modes: g.modes,
      mode: g.mode,
      audiences: g.audiences,
      audience: g.audience,
      checks: g.checks.map((c) => ({ id: c.id, label: c.label })),
      unresolved: g.unresolved,
      target: g.target,
      webPath,
      handover: `Secrets (tokens, signing secrets, client secrets) are typed by the person into their fields on ${webPath}; never ask for one in the conversation. Connecting a personal account and confirming the app was updated (the guide acknowledgement) also happen on that page.`,
    };
  }
}

/** A pending target from a guide state; none when the target has no guide the org sees. */
function pendingOf(
  state: ConnectionGuideState | undefined,
  audience: SetupGuideAudience,
  t: {
    kind: "channel-connection" | "connector";
    id: string;
    name: string;
    query: GuideQuery;
    webPath: string;
  },
): Pending[] {
  const ref = state?.setupGuide;
  if (!ref) return [];
  return [
    {
      itemId: ref.itemId,
      guideId: ref.guideId,
      audience,
      query: t.query,
      target: {
        kind: t.kind,
        id: t.id,
        name: t.name,
        drift: state.guideDrift,
        webPath: t.webPath,
        checked: true,
      },
    },
  ];
}
