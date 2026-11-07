import type { Approval } from "./approvals";
import type { ToolInfo } from "./conversations";
import { parseToolKey } from "./tool-key";

/**
 * How every surface names a tool (tool naming spec §7, as the Claude Code VS Code extension does):
 * a builtin by its name, untranslated (`Bash`); a connector or extension tool as its source's
 * display name with the local tool name in brackets (`CRM [search_accounts]`). The brackets never
 * show the declared title: that is the tooltip.
 */
export interface ToolLabelParts {
  name: string;
  tool?: string;
  tooltip?: string;
}

type Lang = "zh" | "en";
export const lang = (locale: string): Lang => (locale.startsWith("zh") ? "zh" : "en");

/** The label of a tool from its display metadata (`GET …/conversations/:id/tools`). */
export function toolLabel(
  info: Pick<ToolInfo, "key" | "title" | "source" | "aliasOf"> & { tool?: string | null },
  locale: string,
): ToolLabelParts {
  const tooltip = info.title ? { tooltip: info.title } : {};
  const local = info.tool ?? localTool(info.key) ?? info.key;
  switch (info.source.kind) {
    case "builtin":
      // an older key of a builtin (history logged before a rename) shows the current name
      return { name: info.aliasOf ?? info.key, ...tooltip };
    case "connector":
      return { name: info.source.name, tool: local, ...tooltip };
    case "extension":
      return {
        name: info.source.displayName?.[lang(locale)] ?? info.source.name,
        tool: local,
        ...tooltip,
      };
    default:
      return { name: info.key };
  }
}

const localTool = (key: string): string | undefined => {
  const p = parseToolKey(key);
  return p && p.kind !== "builtin" ? p.tool : undefined;
};

/** An approval of a Platform operation is keyed `Platform:<operation>`. */
export const PLATFORM_PREFIX = "Platform:";

/** The label from the key alone (no display metadata): the slug or the extension name stands in. */
export function toolLabelOfKey(key: string): ToolLabelParts {
  // a Platform call is keyed `Platform:<operation>`
  if (key.startsWith(PLATFORM_PREFIX))
    return { name: "Platform", tool: key.slice(PLATFORM_PREFIX.length) };
  const p = parseToolKey(key);
  if (p?.kind === "connector") return { name: p.slug, tool: p.tool };
  if (p?.kind === "extension") return { name: p.plugin, tool: p.tool };
  return { name: key };
}

/** The label of an approval's tool (the approvals API names the connector and the extension). */
export function approvalToolLabel(
  a: Pick<Approval, "toolKey" | "toolName" | "connector"> & {
    extension?: Approval["extension"];
  },
  locale: string,
): ToolLabelParts {
  // `toolName` is the connector's own name for its tool (the key minus `mcp__<slug>__`)
  if (a.connector) return { name: a.connector.name, tool: a.toolName };
  if (a.extension)
    return {
      name: a.extension.displayName[lang(locale)],
      tool: localTool(a.toolKey) ?? a.toolName,
    };
  return toolLabelOfKey(a.toolKey);
}

/** The label as one string: `name [tool]`, or the name. */
export const toolLabelText = (p: ToolLabelParts): string =>
  p.tool ? `${p.name} [${p.tool}]` : p.name;
