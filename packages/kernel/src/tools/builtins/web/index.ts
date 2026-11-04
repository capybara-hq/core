import type { BuiltinTool } from "../../registry.js";
import { type WebFetchDeps, webFetchTool } from "./fetch.js";
import { type WebSearchDeps, webSearchTool } from "./search.js";

export { webToolError } from "./errors.js";
export {
  extractNotAvailable,
  fetchPage,
  WEB_FETCH_SPEC,
  type WebFetchDeps,
  type WebFetchExtract,
  webFetchTool,
} from "./fetch.js";
export { WebPages } from "./page-cache.js";
export { WEB_SEARCH_SPEC, webSearchTool } from "./search.js";
export { normalizeFetchUrl } from "./url.js";

/** What the web builtins need. */
export type WebToolDeps = WebSearchDeps & WebFetchDeps;

/** The web builtins (web tools spec §3), in a fixed order. */
export function webTools(deps: WebToolDeps): BuiltinTool[] {
  return [webSearchTool(deps), webFetchTool(deps)];
}
