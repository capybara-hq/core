import { domainToASCII } from "node:url";
import {
  ToolError,
  type ToolSpec,
  type WebSearchProvider,
  type WebSearchResult,
} from "@capybara-hq/plugin-sdk";
import type { ExtensionPointDefaults } from "../../../extensions/point-defaults.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import { BUILTIN } from "../../builtin-names.js";
import type { BuiltinTool } from "../../registry.js";
import { webToolError } from "./errors.js";

/** The extension point name (without the major) the provider is resolved from. */
const POINT = "web-search";

/**
 * The fixed spec (web tools spec §3.1). No date and nothing per org or provider: `specHash` stays
 * the same across days and providers, so remembered grants survive both and replays match the log.
 * The date is the first line of every result instead.
 */
export const WEB_SEARCH_SPEC: ToolSpec = {
  name: BUILTIN.WebSearch,
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["query"],
  description:
    "Search the web and get a list of results with title, URL and a short snippet. Use it for " +
    "information newer than your training data, or to check whether something you know is still " +
    "current. Then use WebFetch to read the pages you need. Do not use it for questions you can " +
    "answer reliably without the web. Cite the sources you use.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        maxLength: 500,
        description: "The search query.",
      },
      allowed_domains: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 253 },
        maxItems: 50,
        description:
          "Only return results from these domains (hostnames such as example.com; subdomains " +
          "are included). Do not combine with blocked_domains.",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 253 },
        maxItems: 50,
        description:
          "Never return results from these domains (hostnames such as example.com; subdomains " +
          "are included). Do not combine with allowed_domains.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

/** The last line of a result with entries (Claude Code tells the model to list its sources). */
const CITE_LINE = "Cite the sources you use as markdown links in your answer.";

/** Why the tool is unavailable in an org (web tools spec §3.4; English, actionable). */
function unavailableText(reason: "none" | "ambiguous"): string {
  if (reason === "none") {
    return "No web search provider is enabled in this organization; ask an org admin to enable one.";
  }
  return "Several web search providers are enabled and none is the default; ask an org admin to choose one in the organization settings.";
}

interface SearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/**
 * A domain entry as a bare lowercase ASCII hostname: tolerates a scheme, a path, a port, a leading
 * `*.` / `.` and a trailing dot; a Unicode (IDN) name becomes its punycode form, as result hosts
 * are (WHATWG URL parsing). Empty when nothing is left.
 */
function normalizeDomain(entry: string): string {
  let d = entry.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  d = d.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (d === "") return d;
  // domainToASCII is "" for a name IDNA rejects: keep the entry as given (it matches no host)
  return domainToASCII(d) || d;
}

/**
 * A domain list normalized; undefined when absent or empty (no filter). A list whose entries all
 * normalize to nothing stays an empty list, which no host matches.
 */
const normalizeDomains = (list: readonly string[] | undefined): string[] | undefined =>
  list === undefined || list.length === 0
    ? undefined
    : [...new Set(list.map(normalizeDomain).filter((d) => d !== ""))];

/** Whether `host` is `domain` or one of its subdomains. */
const covers = (domain: string, host: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** One usable result, its URL normalized. */
interface Entry {
  title: string;
  url: string;
  date?: string;
  snippet?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The provider's results the model may see (web tools spec §7.2): an absolute http(s) URL, a
 * non-empty title, each URL once, within the domain lists, at most `max`. The kernel filters even
 * when the provider honored the domain hints.
 */
function usable(
  results: readonly WebSearchResult[],
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
  max: number,
): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const r of results) {
    if (out.length >= max) break;
    if (typeof r?.url !== "string" || typeof r.title !== "string") continue;
    const title = oneLine(r.title);
    if (title === "") continue;
    let u: URL;
    try {
      // no base: a relative URL throws
      u = new URL(r.url.trim());
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "") continue;
    if (allowed !== undefined && !allowed.some((d) => covers(d, host))) continue;
    if (blocked?.some((d) => covers(d, host))) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    const date =
      typeof r.publishedAt === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(r.publishedAt.trim()) : null;
    const snippet = typeof r.snippet === "string" ? oneLine(r.snippet) : "";
    out.push({
      title,
      url: u.href,
      ...(date !== null && { date: date[0] }),
      ...(snippet !== "" && { snippet }),
    });
  }
  return out;
}

/** The model-visible result (web tools spec §3.1): the date line first, then the entries. */
function resultText(day: string, entries: readonly Entry[]): string {
  const head = `Search date: ${day} (UTC).`;
  if (entries.length === 0) return `${head}\n\nNo results.`;
  const blocks = entries.map((e, i) =>
    [
      `${i + 1}. ${e.title}`,
      `   URL: ${e.url}`,
      ...(e.date !== undefined ? [`   Published: ${e.date}`] : []),
      ...(e.snippet !== undefined ? [`   ${e.snippet}`] : []),
    ].join("\n"),
  );
  return [head, ...blocks, CITE_LINE].join("\n\n");
}

/** The query in the display summary: one line, at most this many code points. */
const DISPLAY_QUERY_MAX = 120;

function displayQuery(query: string): string {
  const cps = [...oneLine(query)];
  return cps.length > DISPLAY_QUERY_MAX
    ? `${cps.slice(0, DISPLAY_QUERY_MAX - 1).join("")}…`
    : cps.join("");
}

/** What {@link webSearchTool} needs. */
export interface WebSearchDeps {
  points: Pick<ExtensionPointDefaults, "resolve">;
  config: Pick<KernelConfigService, "get">;
  /** The clock of the result's date line (tests fix it). */
  now?: () => Date;
}

/**
 * The builtin `WebSearch` (web tools spec §3.1): searches with the org's `web-search@1` provider
 * (`ExtensionPointDefaults`, resolved per call and per step, never cached), asking it for
 * `web.search.maxResults` results with the domain lists as hints and the org's config, then
 * filters the results again. Default `ask`; unavailable when the org has no provider or several
 * without a default.
 */
export function webSearchTool(deps: WebSearchDeps): BuiltinTool {
  const now = deps.now ?? (() => new Date());
  return {
    spec: WEB_SEARCH_SPEC,
    defaultPolicy: "ask",
    async unavailable({ orgId }) {
      const r = await deps.points.resolve(orgId, POINT);
      return r.ok ? null : unavailableText(r.reason);
    },
    async run(input, ctx) {
      const { query, allowed_domains, blocked_domains } = input as SearchInput;
      if (allowed_domains !== undefined && blocked_domains !== undefined) {
        throw new ToolError(
          "Pass either allowed_domains or blocked_domains, not both; call WebSearch again with one of them.",
        );
      }
      const allowed = normalizeDomains(allowed_domains);
      const blocked = normalizeDomains(blocked_domains);
      // the provider may have changed since the step resolved the tool: resolve again
      const resolved = await deps.points.resolve<WebSearchProvider>(ctx.orgId, POINT);
      if (!resolved.ok) throw new ToolError(unavailableText(resolved.reason));
      const max = deps.config.get().web.search.maxResults;
      const day = now().toISOString().slice(0, 10);
      let results: readonly WebSearchResult[];
      try {
        const out = await resolved.impl.search({
          query,
          ...(allowed !== undefined && allowed.length > 0 && { allowedDomains: allowed }),
          ...(blocked !== undefined && blocked.length > 0 && { blockedDomains: blocked }),
          maxResults: max,
          orgConfig: resolved.orgConfig,
          signal: ctx.signal,
        });
        results = Array.isArray(out?.results) ? out.results : [];
      } catch (e) {
        webToolError(e, "search");
      }
      const entries = usable(results, allowed, blocked, max);
      const q = displayQuery(query);
      const n = entries.length;
      return {
        content: [{ type: "text", text: resultText(day, entries) }],
        display: {
          summary: {
            zh: `搜索网页：${q}（${n} 条结果）`,
            en: `Searched the web: ${q} (${n} result${n === 1 ? "" : "s"})`,
          },
        },
      };
    },
  };
}
