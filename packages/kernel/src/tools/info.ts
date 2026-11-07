import {
  connectorToolKey,
  extensionToolKey,
  type LocalizedName,
  parseToolKey,
  type ToolAnnotations,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ConversationAccess } from "../conversations/access.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { UUID_RE } from "../ui/registry.js";
import { BUILTIN_TOOL_KINDS, SANDBOX_TOOL_NAMES } from "./builtin-names.js";
import { pluginDisplayNames } from "./display-names.js";
import { isLegacyBuiltinKey, LEGACY_BUILTINS, type LegacyBuiltin } from "./legacy-keys.js";
import { toolKeyIssue } from "./naming.js";
import { OrgToolSwitches } from "./org-tool-switches.js";
import { policyFromAnnotations, ToolRegistry } from "./registry.js";

/**
 * Tool presentation metadata for the conversation page (UI refresh B, design spec §6.16.9): the
 * kind picks the row verb and the group counts, the title and key arguments the row's wording.
 * Display only: nothing here reaches the model.
 */
export type ToolKind = "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";

export interface ToolInfo {
  /** The model-visible tool key, as asked for. */
  key: string;
  /**
   * Set only for a release-candidate builtin key (old history, tool naming spec §9): the current
   * tool it stands for. Everything else describes that tool, with `keyArgs` in the old parameter
   * names the logged input carries. Pages map a call's name through it (the `Agent` row, labels).
   */
  aliasOf?: string;
  /** The declared display title (`ToolSpec.title`), or null. */
  title: string | null;
  kind: ToolKind;
  /** True exactly for the builtin tools that run in the conversation's sandbox. */
  sandbox: boolean;
  /** The declared key arguments (`ToolSpec.keyArgs`), or []. */
  keyArgs: string[];
  /**
   * The local tool name parsed from a connector or extension key (`mcp__crm__delete` -> `delete`),
   * shown in brackets after the source's display name; null for builtins and unparsable keys.
   */
  tool: string | null;
  source:
    | { kind: "builtin" }
    /** `displayName`: the plugin's catalog display name, else its name. */
    | { kind: "extension"; name: string; displayName: LocalizedName }
    | { kind: "connector"; id: string; name: string }
    /** No tool with this key exists now (removed connector, unloaded extension, …). */
    | { kind: "unknown" };
}

export { BUILTIN_TOOL_KINDS } from "./builtin-names.js";

/** At most this many keys per request, each at most {@link TOOL_INFO_KEY_MAX} characters. */
export const TOOL_INFO_MAX_KEYS = 100;
export const TOOL_INFO_KEY_MAX = 200;

export interface ToolInfoDeps {
  db: KernelSchemaDb;
  registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">;
}

const display = (spec: ToolSpec | undefined) => ({
  title: typeof spec?.title === "string" ? spec.title : null,
  keyArgs: Array.isArray(spec?.keyArgs) ? [...spec.keyArgs] : [],
});

/**
 * Presentation metadata for `keys` in this org, in request order with repeats dropped. Builtins
 * by name (a release-candidate builtin key as its current tool, with `aliasOf`); `plugin__<plugin>__<tool>` keys as a loaded extension's registration, and `mcp__<slug>__<tool>` keys as a live
 * connector's current stored tool (its reviewed definition, never a pending one). Anything else
 * comes back as an unknown plain tool.
 *
 * - Titles and key arguments are never read from `tool_specs`: it is content-addressed by
 *   `specHash`, which leaves the display fields out, so it keeps whichever title was stored first
 *   under a hash. Eval and trajectory viewers must not show a title from it either.
 * - Extension tools resolve deployment-wide (from the loaded host), not per org: a tool of an
 *   extension that is not enabled in this org still answers `source: extension` with its title.
 *   That is deliberate: old conversation logs keep their labels, and the data is not sensitive.
 * - A key whose prefix is both a loaded extension's name and a connector slug resolves to the
 *   extension. When an agent's tools are built, the registry's `claim()` reports that collision;
 *   here it only changes the label.
 */
export async function toolInfo(
  deps: ToolInfoDeps,
  orgId: string,
  keys: readonly string[],
): Promise<ToolInfo[]> {
  const unique = [...new Set(keys)];
  const builtins = new Map(deps.registry.builtinSpecs().map((s) => [s.name, s]));
  const extensions = new Map(
    deps.registry.extensionToolSpecs().map((t) => [extensionToolKey(t.plugin, t.spec.name), t]),
  );
  const slugs = [
    ...new Set(
      unique.flatMap((k) => {
        if (builtins.has(k) || extensions.has(k)) return [];
        const p = parseToolKey(k);
        return p?.kind === "connector" ? [p.slug] : [];
      }),
    ),
  ];
  const connectorRows =
    slugs.length === 0
      ? []
      : await deps.db
          .selectFrom("connectors as c")
          .innerJoin("connector_tools as t", "t.connector_id", "c.id")
          .select(["c.id", "c.slug", "c.name", "t.name as tool", "t.spec"])
          .where("c.org_id", "=", orgId)
          .where("c.deleted_at", "is", null)
          .where("c.slug", "in", slugs)
          .execute();
  const connectorTools = new Map(connectorRows.map((r) => [connectorToolKey(r.slug, r.tool), r]));
  const displayNames = await pluginDisplayNames(
    deps.db,
    unique.flatMap((k) => {
      const e = extensions.get(k);
      return e ? [e.plugin] : [];
    }),
  );
  const localTool = (key: string): string | null => {
    const p = parseToolKey(key);
    return p && p.kind !== "builtin" ? p.tool : null;
  };

  const builtinInfo = (key: string, name: string, spec: ToolSpec): ToolInfo => ({
    key,
    ...display(spec),
    kind: BUILTIN_TOOL_KINDS[name] ?? "tool",
    sandbox: (SANDBOX_TOOL_NAMES as readonly string[]).includes(name),
    tool: null,
    source: { kind: "builtin" },
  });

  return unique.map((key): ToolInfo => {
    const b = builtins.get(key);
    if (b) return builtinInfo(key, key, b);
    const legacy = isLegacyBuiltinKey(key) ? (LEGACY_BUILTINS[key] as LegacyBuiltin) : undefined;
    const current = legacy && builtins.get(legacy.name);
    if (legacy && current) {
      // the logged input of an rc call names the old parameters: key arguments in those names
      const oldName = new Map(Object.entries(legacy.params).map(([o, n]) => [n, o]));
      const info = builtinInfo(key, legacy.name, current);
      return {
        ...info,
        aliasOf: legacy.name,
        keyArgs: info.keyArgs.map((a) => oldName.get(a) ?? a),
      };
    }
    const e = extensions.get(key);
    if (e)
      return {
        key,
        ...display(e.spec),
        kind: "tool",
        sandbox: false,
        tool: e.spec.name,
        source: {
          kind: "extension",
          name: e.plugin,
          displayName: displayNames.get(e.plugin) ?? { zh: e.plugin, en: e.plugin },
        },
      };
    const c = connectorTools.get(key);
    if (c) {
      // The reviewed definition: a pending (unreviewed) one never supplies display text.
      return {
        key,
        ...display(c.spec as ToolSpec),
        kind: "connector",
        sandbox: false,
        tool: c.tool,
        source: { kind: "connector", id: c.id, name: c.name },
      };
    }
    return {
      key,
      title: null,
      kind: "tool",
      sandbox: false,
      keyArgs: [],
      tool: localTool(key),
      source: { kind: "unknown" },
    };
  });
}

/** `GET /conversations/:id/tools`: {@link toolInfo} for a conversation the viewer can read. */
@Injectable()
export class ConversationToolInfo {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">,
    /** Conversation visibility (the same rule as the events API). */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
  ) {}

  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    keys: readonly string[],
  ): Promise<ToolInfo[]> {
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.access.isAccessible(orgId, conversationId, viewerAccountId))
    ) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
    return toolInfo({ db: this.db.db, registry: this.registry }, orgId, keys);
  }
}

/** One tool of {@link OrgExtensionTools}. Display only, for the agent form. */
export interface ExtensionToolOffer {
  /** The tool's registered name (the `name` of a `{kind:"plugin"}` reference). */
  name: string;
  /** The model-visible key, `plugin__<plugin>__<name>` (the `toolPolicies` key). */
  key: string;
  /** The declared display title (`ToolSpec.title`), or null. */
  title: string | null;
  /** The first non-empty line of the tool's description (English, model-facing text). */
  description: string;
  annotations: ToolAnnotations;
  /** The tool's default policy: its `defaultPolicy`, else derived from the annotations. */
  defaultPolicy: "allow" | "ask";
  /**
   * The org turned this tool off (layering spec A §7): still listed, so the form shows it as
   * unavailable in the agents that selected it.
   */
  switchedOff: boolean;
}

/** One extension of {@link OrgExtensionTools} with its tools, in registration order. */
export interface ExtensionToolsOffer {
  plugin: string;
  /** The plugin's catalog display name, else its name. */
  displayName: LocalizedName;
  tools: ExtensionToolOffer[];
}

/**
 * `GET /orgs/:orgId/tools/extensions`: the tools an agent of this org can reference by
 * `{kind:"plugin"}` and get at run time, grouped by extension: the extensions loaded on this
 * replica and enabled in the org (`enabled.ts`, through the host), each with the tools it
 * registered whose key is valid (`ToolRegistry.forAgent` reports the others unavailable); a tool
 * the org turned off is listed with `switchedOff`.
 */
@Injectable()
export class OrgExtensionTools {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, "extensionToolSpecs" | "enabledExtensions">,
    @Inject(OrgToolSwitches) private readonly switches: Pick<OrgToolSwitches, "offKeys">,
  ) {}

  async list(orgId: string): Promise<ExtensionToolsOffer[]> {
    const [enabled, off] = await Promise.all([
      this.registry.enabledExtensions(orgId),
      this.switches.offKeys(orgId),
    ]);
    const groups = new Map<string, ExtensionToolOffer[]>();
    for (const t of this.registry.extensionToolSpecs()) {
      if (!enabled.has(t.plugin)) continue;
      const key = extensionToolKey(t.plugin, t.spec.name);
      if (toolKeyIssue(key) !== null) continue;
      const tools = groups.get(t.plugin) ?? [];
      if (tools.some((x) => x.name === t.spec.name)) continue;
      tools.push({
        name: t.spec.name,
        key,
        title: display(t.spec).title,
        description: firstLine(t.spec.description),
        annotations: { ...(t.spec.annotations ?? {}) },
        defaultPolicy: t.spec.defaultPolicy ?? policyFromAnnotations(t.spec.annotations),
        switchedOff: off.has(key),
      });
      groups.set(t.plugin, tools);
    }
    const names = await pluginDisplayNames(this.db.db, [...groups.keys()]);
    return [...groups].map(([plugin, tools]) => ({
      plugin,
      displayName: names.get(plugin) ?? { zh: plugin, en: plugin },
      tools,
    }));
  }
}

const firstLine = (s: string): string =>
  (typeof s === "string" ? s : "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";
