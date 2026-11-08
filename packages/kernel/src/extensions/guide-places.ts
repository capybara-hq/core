// The kernel side of the setup guide places (spec 2026-11-09-setup-guides-v2-design.md §6.3, §9):
// the SDK registry (`SETUP_GUIDE_PLACE_INFO`) says which modes, audiences and variables a place
// has; this module adds, per place, the org action each audience needs, the target lookup (a live
// object of the org on the guide's plugin, else 404) and the variable values with the reason a
// known variable has no value. No value ever comes from a target's config, a secret, a token or a
// client id: only names, ids, versions and the two URL settings.
import {
  type PluginSetupGuide,
  SETUP_GUIDE_PLACE_INFO,
  type SetupGuideAudience,
  type SetupGuidePlace,
} from "@capybara-hq/plugin-sdk";
import { webhookBase, webhookUrlOf } from "../channels/webhook-url.js";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import type { KernelDb } from "../infra/database/kernel-db.js";
import type { OrgAction } from "../orgs/roles.js";
import { OAUTH_CALLBACK_PATH } from "../tools/oauth/flow-paths.js";

/** Why a known variable has no value: what the web and the `Platform` tool tell the reader. */
export type UnresolvedReason =
  /** The target is not saved yet (the webhook URL, a connection name nobody typed). */
  | "not_saved"
  /** `http.publicUrl` is not set (the URLs built from it). */
  | "public_url"
  /** `channels.webhookBaseUrl` is not set or unusable. */
  | "webhook_base"
  /** No connector is made from the template yet. */
  | "no_connector"
  /** Rendered for the platform (the super admin's preview), not for an org. */
  | "no_org";

/** The org action each audience of a place needs besides `catalog.read` (spec §9.1). */
export const PLACE_ACTIONS: Readonly<
  Record<SetupGuidePlace, Readonly<Partial<Record<SetupGuideAudience, OrgAction>>>>
> = {
  "channel-connection": { admin: "channels.manage" },
  "connector-template": { admin: "connectors.manage", member: "connectors.use" },
};

/** The object a guide is rendered for. */
export interface GuideTarget {
  kind: "channel-connection" | "connector";
  id: string;
}

/** The target parameters of the guide route, per place. */
export interface GuideTargetQuery {
  connectionId?: string | undefined;
  name?: string | undefined;
  connectorId?: string | undefined;
}

/** What a place resolves for one rendering (the mode is the caller's: it picks it from these). */
export interface PlaceResolution {
  /** Every variable of the place except `mode`; null = known without a value. */
  values: Record<string, string | null>;
  /** The reason of each variable that is null in `values`. */
  reasons: Record<string, UnresolvedReason>;
  target: GuideTarget | null;
  /** The target's stored mode (a channel connection's `inbound_mode`), null without one. */
  storedMode: string | null;
}

/** Where the values come from. */
export interface PlaceContext {
  db: KernelDb;
  config: Pick<KernelConfig, "http" | "channels"> & {
    tools: Pick<KernelConfig["tools"], "oauthAllowInsecureLoopback">;
  };
  item: { id: string; name: string; version: string };
  guide: PluginSetupGuide;
  locale: "en" | "zh";
  /** The org rendered for; null for the platform preview (no org, no target). */
  org: { orgId: string; name: string } | null;
  query: GuideTargetQuery;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidQuery = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

/** The target parameters each place takes; another place's parameter is 400. */
const TARGET_PARAMS: Record<SetupGuidePlace, readonly (keyof GuideTargetQuery)[]> = {
  "channel-connection": ["connectionId", "name"],
  "connector-template": ["connectorId"],
};

/**
 * The variable values of a place for one rendering (spec §6.3): the common ones, then the place's
 * own from its target. Throws 400 `validation_failed` for another place's target parameter and 404
 * (`channel.not_found`, `connector.not_found`) for a target that is not a live object of the org on
 * the guide's plugin.
 */
export async function resolvePlace(ctx: PlaceContext): Promise<PlaceResolution> {
  const place = ctx.guide.place;
  for (const key of Object.keys(ctx.query) as (keyof GuideTargetQuery)[]) {
    if (ctx.query[key] !== undefined && !TARGET_PARAMS[place].includes(key)) {
      throw invalidQuery(key, `${key} is not a target of a ${place} guide`);
    }
  }
  const publicUrl = ctx.config.http.publicUrl?.replace(/\/+$/, "") ?? null;
  const values: Record<string, string | null> = {
    publicUrl,
    orgName: ctx.org?.name ?? null,
    pluginName: ctx.item.name,
    pluginVersion: ctx.item.version,
  };
  const reasons: Record<string, UnresolvedReason> = {};
  const signIn =
    publicUrl === null
      ? null
      : `${publicUrl}/api/v1/auth/sso/${encodeURIComponent(ctx.item.name)}/callback`;
  let target: GuideTarget | null = null;
  let storedMode: string | null = null;

  if (place === "channel-connection") {
    const connection =
      ctx.query.connectionId === undefined
        ? undefined
        : await liveConnection(ctx, ctx.query.connectionId);
    const base = webhookBase(ctx.config);
    values.webhookUrl =
      connection !== undefined && base !== undefined ? webhookUrlOf(base, connection.id) : null;
    reasons.webhookUrl = connection === undefined ? "not_saved" : "webhook_base";
    values.signInCallbackUrl = signIn;
    const typed = ctx.query.name?.trim();
    values.connectionName =
      connection?.name ?? (typed === undefined || typed === "" ? null : typed);
    reasons.connectionName = "not_saved";
    if (connection !== undefined) {
      target = { kind: "channel-connection", id: connection.id };
      storedMode = connection.inbound_mode;
    }
  } else {
    // The connector made from the template is looked up by Task 6 of the setup guides v2 plan;
    // until then no connector id resolves (a 404 rather than a guide for an unchecked id).
    if (ctx.query.connectorId !== undefined) {
      throw new ApiError("connector.not_found", "Connector not found");
    }
    values.oauthCallbackUrl = publicUrl === null ? null : `${publicUrl}${OAUTH_CALLBACK_PATH}`;
    values.signInCallbackUrl = signIn;
    values.templateId = ctx.guide.template ?? null;
    values.templateName = await templateName(ctx);
    values.connectorName = null;
    reasons.connectorName = "no_connector";
  }
  reasons.publicUrl = "public_url";
  reasons.signInCallbackUrl = "public_url";
  reasons.oauthCallbackUrl = "public_url";
  reasons.orgName = "no_org";
  // keep only the reasons of variables that are the place's and have no value
  const known = SETUP_GUIDE_PLACE_INFO[place].variables;
  for (const name of Object.keys(reasons)) {
    if (!Object.hasOwn(known, name) || values[name] !== null) delete reasons[name];
  }
  return { values, reasons, target, storedMode };
}

/** A live connection of the org on the guide's plugin; otherwise `channel.not_found`. */
async function liveConnection(ctx: PlaceContext, id: string) {
  const notFound = () => new ApiError("channel.not_found", "Channel connection not found");
  if (ctx.org === null || !UUID_RE.test(id)) throw notFound();
  const c = await ctx.db
    .selectFrom("channel_connections")
    .select(["id", "name", "inbound_mode"])
    .where("id", "=", id)
    .where("org_id", "=", ctx.org.orgId)
    .where("plugin", "=", ctx.item.name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!c) throw notFound();
  return c;
}

/**
 * The template's display name in the document's language, from the platform component made from
 * it at import (`platform_connector_templates.file`); the template id when there is none.
 */
async function templateName(ctx: PlaceContext): Promise<string | null> {
  const id = ctx.guide.template;
  if (id === undefined) return null;
  const row = await ctx.db
    .selectFrom("platform_connector_templates")
    .select("file")
    .where("catalog_item_id", "=", ctx.item.id)
    .where("template_id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const name = (row?.file as { displayName?: { en?: unknown; zh?: unknown } } | undefined)
    ?.displayName;
  const localized = ctx.locale === "zh" ? name?.zh : name?.en;
  return typeof localized === "string" && localized !== "" ? localized : id;
}
