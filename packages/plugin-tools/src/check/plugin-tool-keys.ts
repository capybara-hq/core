import { findToolRegistrations } from "./plugin-permissions.js";
import type { Finding } from "./source.js";

export type { Finding };

/** The model-visible key of an extension tool is `plugin__<extension>__<tool>`; 64 characters at most. */
export const TOOL_KEY_PREFIX = "plugin__";
export const TOOL_KEY_MAX = 64;

/**
 * plugin-tool-key-length: the key `plugin__<extension>__<tool>` of every `ctx.tools.register`
 * must fit in {@link TOOL_KEY_MAX} characters (model APIs cap tool names at 64). The names must be
 * string literals or same-file consts, as for `perm-tools`; a name that is not is reported as
 * "cannot be confirmed statically" unless the call carries `// capybara:allow-dynamic-permission
 * <reason>`. Scans the non-test sources under `pluginDirs`.
 */
export function checkPluginToolKeys(pluginDirs: string[]): Finding[] {
  const rule = "plugin-tool-key-length";
  const out: Finding[] = [];
  for (const r of findToolRegistrations(pluginDirs)) {
    if (r.extension === undefined || r.tool === undefined) {
      if (r.allowed) continue;
      out.push({
        file: r.file,
        line: r.line,
        rule,
        message: `Cannot statically confirm the length of the tool key (${r.extension === undefined ? "extension name" : "tool name"} is not a literal). Use a string literal (or a same-file const), or add // capybara:allow-dynamic-permission <reason>`,
      });
      continue;
    }
    const key = `${TOOL_KEY_PREFIX}${r.extension}__${r.tool}`;
    if (key.length > TOOL_KEY_MAX) {
      out.push({
        file: r.file,
        line: r.line,
        rule,
        message: `Tool key "${key}" is ${key.length} characters; the limit is ${TOOL_KEY_MAX} (plugin__<extension>__<tool>). Shorten the tool name to at most ${Math.max(0, TOOL_KEY_MAX - TOOL_KEY_PREFIX.length - r.extension.length - 2)} characters or the extension name`,
      });
    }
  }
  return out;
}
