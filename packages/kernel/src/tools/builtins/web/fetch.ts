import {
  ToolError,
  type ToolSpec,
  type WebFetchPage,
  type WebFetchProvider,
} from "@capybara-hq/plugin-sdk";
import type { ExtensionPointDefaults } from "../../../extensions/point-defaults.js";
import type { KernelConfigService } from "../../../infra/config/kernel-config.service.js";
import { BUILTIN } from "../../builtin-names.js";
import type { BuiltinCallContext, BuiltinTool } from "../../registry.js";
import { webToolError } from "./errors.js";
import type { WebPages } from "./page-cache.js";
import { normalizeFetchUrl } from "./url.js";

/** The extension point name (without the major) the provider is resolved from. */
const POINT = "web-fetch";

/** Appended to a page cut at `web.fetch.maxPageChars` (seen by the extraction model only). */
export const TRUNCATED_MARKER = "\n[truncated]";

/**
 * The fixed spec (web tools spec §3.2). Nothing per org or provider: `specHash` stays the same
 * across providers, so remembered grants survive a change of the org's default provider.
 */
export const WEB_FETCH_SPEC: ToolSpec = {
  name: BUILTIN.WebFetch,
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["url", "prompt"],
  description:
    "Fetch a web page and answer a question about it. Pass the full URL and a prompt saying what " +
    "to extract; the page is read and a smaller model answers the prompt from it, so the result " +
    "is the answer, not the raw page. Use it after WebSearch, or when the user gives you a URL. " +
    "It is read-only. HTTP URLs are upgraded to HTTPS. If the URL redirects to another host, " +
    "the result tells you the new URL to fetch.",
  inputSchema: {
    type: "object",
    properties: {
      // No `format: "uri"` and no maxLength: the kernel checks the URL itself (normalizeFetchUrl)
      // and its errors tell the model what to pass.
      url: { type: "string", description: "The full URL of the page to fetch." },
      prompt: {
        type: "string",
        minLength: 1,
        description: "What to extract from the page, or the question to answer from it.",
      },
    },
    required: ["url", "prompt"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

/** Why the tool is unavailable in an org (web tools spec §3.4; English, actionable). */
function unavailableText(reason: "none" | "ambiguous"): string {
  if (reason === "none") {
    return "No web fetch provider is enabled in this organization; ask an org admin to enable one.";
  }
  return "Several web fetch providers are enabled and none is the default; ask an org admin to choose one in the organization settings.";
}

/** The page's markdown cut to `max` characters with {@link TRUNCATED_MARKER}; idempotent. */
function capMarkdown(page: WebFetchPage, max: number): WebFetchPage {
  if (page.markdown.length <= max) return page;
  return { ...page, markdown: `${page.markdown.slice(0, max)}${TRUNCATED_MARKER}` };
}

/** A provider's page with only the fields of the contract, of the right types. */
function cleanPage(p: unknown, url: string): WebFetchPage {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    finalUrl: typeof o.finalUrl === "string" && o.finalUrl.trim() !== "" ? o.finalUrl : url,
    markdown: typeof o.markdown === "string" ? o.markdown : "",
    ...(typeof o.title === "string" && { title: o.title }),
    ...(typeof o.contentType === "string" && { contentType: o.contentType }),
  };
}

/** What {@link fetchPage} needs. */
export interface WebFetchPageDeps {
  points: Pick<ExtensionPointDefaults, "resolve">;
  config: Pick<KernelConfigService, "get">;
  cache: Pick<WebPages, "get" | "set">;
}

/** The outcome of {@link fetchPage}: the page to extract from, or a redirect to another host. */
export type FetchedPage =
  | { kind: "page"; page: WebFetchPage }
  | { kind: "redirect"; finalUrl: string };

/**
 * Fetches `url` (already checked by {@link normalizeFetchUrl}) with the org's `web-fetch@1`
 * provider (resolved per call, never cached in process), through the page cache. The provider's
 * `finalUrl` is checked like any URL before the model can see it: a final URL on another host is
 * returned as a `redirect` (no extraction; web tools spec §3.2), one WebFetch may not fetch is an
 * error. An empty page is an error; a long one is cut to `web.fetch.maxPageChars`.
 */
export async function fetchPage(
  deps: WebFetchPageDeps,
  ctx: Pick<BuiltinCallContext, "orgId" | "signal">,
  url: string,
): Promise<FetchedPage> {
  const resolved = await deps.points.resolve<WebFetchProvider>(ctx.orgId, POINT);
  if (!resolved.ok) throw new ToolError(unavailableText(resolved.reason));
  const max = deps.config.get().web.fetch.maxPageChars;
  let page = await deps.cache.get(ctx.orgId, resolved.extension, url);
  if (page === null) {
    let fetched: unknown;
    try {
      fetched = await resolved.impl.fetch({
        url,
        orgConfig: resolved.orgConfig,
        signal: ctx.signal,
      });
    } catch (e) {
      webToolError(e, "fetch");
    }
    // cached already cut, so a large page costs Redis no more than the model may read
    page = capMarkdown(cleanPage(fetched, url), max);
    await deps.cache.set(ctx.orgId, resolved.extension, url, page);
  }
  const final = normalizeFetchUrl(page.finalUrl);
  if (!final.ok) {
    throw new ToolError(
      `The URL redirected to ${page.finalUrl}, which WebFetch cannot fetch; use another URL.`,
    );
  }
  if (new URL(final.url).hostname !== new URL(url).hostname) {
    return { kind: "redirect", finalUrl: final.url };
  }
  if (page.markdown.trim() === "") {
    throw new ToolError("The page has no readable text; use another URL.");
  }
  return { kind: "page", page: capMarkdown({ ...page, finalUrl: final.url }, max) };
}

/** The extraction call (web tools spec §5): the page and the prompt in, a short answer out. */
export type WebFetchExtract = (
  ctx: BuiltinCallContext,
  page: WebFetchPage,
  prompt: string,
) => Promise<string>;

/**
 * The extraction until the `web_fetch` model call lands: always fails with the extraction error,
 * so no raw page ever reaches the model (an anti-goal of the web tools spec).
 */
export const extractNotAvailable: WebFetchExtract = async () => {
  throw new ToolError("Could not extract an answer from the page; retry, or try another URL.");
};

/** What {@link webFetchTool} needs. */
export interface WebFetchDeps extends WebFetchPageDeps {
  extract: WebFetchExtract;
}

interface FetchInput {
  url: string;
  prompt: string;
}

/**
 * The builtin `WebFetch` (web tools spec §3.2): checks and upgrades the URL, fetches the page with
 * the org's `web-fetch@1` provider ({@link fetchPage}) and answers `prompt` from it with one
 * extraction call; the result is the answer headed by the URL, never the raw page. A redirect to
 * another host returns the new URL instead. Default `ask`; unavailable when the org has no
 * provider or several without a default.
 */
export function webFetchTool(deps: WebFetchDeps): BuiltinTool {
  return {
    spec: WEB_FETCH_SPEC,
    defaultPolicy: "ask",
    async unavailable({ orgId }) {
      const r = await deps.points.resolve(orgId, POINT);
      return r.ok ? null : unavailableText(r.reason);
    },
    async run(input, ctx) {
      const { url: rawUrl, prompt } = input as FetchInput;
      const checked = normalizeFetchUrl(rawUrl);
      if (!checked.ok) throw new ToolError(`${checked.error} Then call WebFetch again.`);
      const url = checked.url;
      const host = new URL(url).hostname;
      const display = { summary: { zh: `读取网页：${host}`, en: `Read ${host}` } };
      const fetched = await fetchPage(deps, ctx, url);
      if (fetched.kind === "redirect") {
        return {
          content: [
            {
              type: "text",
              text: `The URL redirected to ${fetched.finalUrl}. Call WebFetch again with that URL if you want its content.`,
            },
          ],
          display,
        };
      }
      const answer = await deps.extract(ctx, fetched.page, prompt);
      const head =
        fetched.page.finalUrl === url
          ? `URL: ${url}`
          : `URL: ${url}\nFinal URL: ${fetched.page.finalUrl}`;
      return { content: [{ type: "text", text: `${head}\n\n${answer}` }], display };
    },
  };
}
