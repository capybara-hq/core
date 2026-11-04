import type { BuiltinTool } from "../../registry.js";
import { type WebSearchDeps, webSearchTool } from "./search.js";

export { webToolError } from "./errors.js";
export { WEB_SEARCH_SPEC, webSearchTool } from "./search.js";

/** What the web builtins need. */
export type WebToolDeps = WebSearchDeps;

/** The web builtins (web tools spec §3), in a fixed order. */
export function webTools(deps: WebToolDeps): BuiltinTool[] {
  return [webSearchTool(deps)];
}
