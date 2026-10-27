import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { UUID_RE } from "../ui/registry.js";
import { KEY_SEPARATOR, toolKey } from "./naming.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Tool presentation metadata for the conversation page (UI refresh B, design spec §6.16.9): the
 * kind picks the row verb and the group counts, the title and key arguments the row's wording.
 * Display only: nothing here reaches the model.
 */
export type ToolKind = "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";

export interface ToolInfo {
  /** The model-visible tool key, as asked for. */
  key: string;
  /** The declared display title (`ToolSpec.title`), or null. */
  title: string | null;
  kind: ToolKind;
  /** The declared key arguments (`ToolSpec.keyArgs`), or []. */
  keyArgs: string[];
  source:
    | { kind: "builtin" }
    | { kind: "extension"; name: string }
    | { kind: "connector"; id: string; name: string }
    /** No tool with this key exists now (removed connector, unloaded extension, …). */
    | { kind: "unknown" };
}

/** Kinds of the kernel builtin tools; a builtin missing here is a plain `tool`. */
export const BUILTIN_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  sandbox_bash: "command",
  sandbox_read: "read",
  sandbox_write: "edit",
  sandbox_edit: "edit",
  sandbox_glob: "search",
  sandbox_grep: "search",
  sandbox_deliver: "tool",
  tool_search: "meta",
  skill_load: "meta",
  skill_write: "meta",
  read_tool_output: "meta",
  ask_user: "meta",
};

/** At most this many keys per request, each at most {@link TOOL_INFO_KEY_MAX} characters. */
export const TOOL_INFO_MAX_KEYS = 100;
export const TOOL_INFO_KEY_MAX = 200;

export interface ToolInfoDeps {
  db: KernelDb;
  registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">;
}

const display = (spec: ToolSpec | undefined) => ({
  title: typeof spec?.title === "string" ? spec.title : null,
  keyArgs: Array.isArray(spec?.keyArgs) ? [...spec.keyArgs] : [],
});

/**
 * Presentation metadata for `keys` in this org, in request order with repeats dropped. Builtins
 * by name; `<prefix>__<tool>` keys first as a loaded extension's registration, then as a live
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
    deps.registry.extensionToolSpecs().map((t) => [toolKey(t.plugin, t.spec.name), t]),
  );
  const split = (key: string): [string, string] | null => {
    const i = key.indexOf(KEY_SEPARATOR);
    return i > 0 ? [key.slice(0, i), key.slice(i + KEY_SEPARATOR.length)] : null;
  };
  const slugs = [
    ...new Set(
      unique.flatMap((k) => {
        if (builtins.has(k) || extensions.has(k)) return [];
        const p = split(k);
        return p ? [p[0]] : [];
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
  const connectorTools = new Map(connectorRows.map((r) => [toolKey(r.slug, r.tool), r]));

  return unique.map((key): ToolInfo => {
    const b = builtins.get(key);
    if (b) {
      return {
        key,
        ...display(b),
        kind: BUILTIN_TOOL_KINDS[key] ?? "tool",
        source: { kind: "builtin" },
      };
    }
    const e = extensions.get(key);
    if (e)
      return {
        key,
        ...display(e.spec),
        kind: "tool",
        source: { kind: "extension", name: e.plugin },
      };
    const c = connectorTools.get(key);
    if (c) {
      // The reviewed definition: a pending (unreviewed) one never supplies display text.
      return {
        key,
        ...display(c.spec as ToolSpec),
        kind: "connector",
        source: { kind: "connector", id: c.id, name: c.name },
      };
    }
    return { key, title: null, kind: "tool", keyArgs: [], source: { kind: "unknown" } };
  });
}

export interface ConversationToolInfoDeps extends ToolInfoDeps {
  /** Conversation visibility (the same rule as the events API: `ConversationsService.isAccessible`). */
  isAccessible(orgId: string, conversationId: string, viewerAccountId: string): Promise<boolean>;
}

/** `GET /conversations/:id/tools`: {@link toolInfo} for a conversation the viewer can read. */
export class ConversationToolInfo {
  constructor(private readonly d: ConversationToolInfoDeps) {}

  async get(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    keys: readonly string[],
  ): Promise<ToolInfo[]> {
    if (
      !UUID_RE.test(conversationId) ||
      !(await this.d.isAccessible(orgId, conversationId, viewerAccountId))
    ) {
      throw new ApiError("conversation.not_found", "Conversation not found");
    }
    return toolInfo(this.d, orgId, keys);
  }
}
