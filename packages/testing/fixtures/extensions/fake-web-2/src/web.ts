import {
  secret,
  type WebFetchPage,
  type WebFetchProvider,
  WebProviderError,
  type WebProviderErrorKind,
  type WebSearchProvider,
  type WebSearchResult,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

// fake-web/src/web.ts and fake-web-2/src/web.ts are byte-identical (a plugin imports only from its
// own directory); test/fixtures.test.ts of @capybara-hq/testing keeps them equal.

/**
 * Org config of the fake web providers: `configured()` is true iff `token` is set (and throws for
 * the token `throw:configured`).
 */
export const FakeWebOrgConfig = z.object({ token: secret(z.string().min(1)).optional() });

/** One provider call, recorded on `globalThis.__fakeWeb` (in-process kernels only). */
export interface FakeWebCall {
  provider: string;
  op: "search" | "fetch";
  /** The query (search) or the URL (fetch). */
  input: string;
}

/** The probe tests read: every call of every fake web provider in this process. */
export function fakeWebProbe(): { calls: FakeWebCall[] } {
  const g = globalThis as { __fakeWeb?: { calls: FakeWebCall[] } };
  g.__fakeWeb ??= { calls: [] };
  return g.__fakeWeb;
}

// capybara:allow-module-state a read-only constant list
const KINDS: readonly WebProviderErrorKind[] = [
  "not_found",
  "blocked",
  "auth",
  "rate_limited",
  "unavailable",
  "invalid",
];

/** True iff the token is set; the token `throw:configured` makes it throw. */
const configured = (orgConfig: unknown): boolean => {
  const token = (orgConfig as { token?: unknown } | null)?.token;
  if (token === "throw:configured") throw new Error("fake web: configured() failed");
  return typeof token === "string" && token.length > 0;
};

/** The script of a fetch: the decoded URL path (and query) after the first `/`. */
function fetchScript(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.slice(1)) + u.search;
  } catch {
    return "";
  }
}

/** Rejects with the signal's reason once it aborts (`hang:`). */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The scripted failures shared by search and fetch; returns normally for other scripts. */
async function scriptedFailure(name: string, script: string, signal: AbortSignal): Promise<void> {
  if (script.startsWith("error:")) {
    const kind = script.slice("error:".length).split(/[\s/?]/)[0] as WebProviderErrorKind;
    if (!KINDS.includes(kind)) throw new Error(`${name}: unknown scripted error kind ${kind}`);
    throw new WebProviderError(`${name}: scripted ${kind} failure`, { kind });
  }
  if (script.startsWith("throw:")) {
    throw new Error(`${name} internal failure: ${script.slice("throw:".length)}`);
  }
  if (script.startsWith("hang:")) await hang(signal);
}

/**
 * The two providers of a fake web extension named `name`. Behavior is scripted by a prefix of the
 * search `query`, or of the fetched URL's path after the first `/` (e.g.
 * `https://example.com/redirect:https://other.com/x`):
 * - `error:<kind>`: throws `WebProviderError` of that kind;
 * - `throw:<text>`: throws a plain `Error` whose message names the provider and carries `<text>`;
 * - `hang:`: waits until the signal aborts, then rejects with its reason;
 * - `redirect:<url>` (fetch): the page's `finalUrl` is `<url>`;
 * - `redirect-long:<n>` (fetch): the page's `finalUrl` is `https://example.com/` followed by `n`
 *   characters;
 * - `junk:` (search): unusable results (relative URL, `javascript:`, `ftp:`, empty title) plus one
 *   usable result and a second result with its URL; `junk:all`: only the four unusable ones;
 * - `idn:` (search): one result on the IDN host `bücher.example` (its URL parses to the punycode
 *   host `xn--bcher-kva.example`) and one on example.org;
 * - `empty:`: no results (search) / an empty `markdown` (fetch);
 * - `big:<n>`: `n` results, ignoring `maxResults` (search) / `n` characters of markdown (fetch).
 * Anything else: three results on docs.example.com, example.org and www.example.net (search) or
 * a short page (fetch). Every title, snippet and page names the provider.
 */
export function makeFakeWeb(name: string): { search: WebSearchProvider; fetch: WebFetchProvider } {
  const search: WebSearchProvider = {
    configured,
    async search({ query, signal }) {
      fakeWebProbe().calls.push({ provider: name, op: "search", input: query });
      await scriptedFailure(name, query, signal);
      if (query.startsWith("empty:")) return { results: [] };
      if (query.startsWith("idn:")) {
        return {
          results: [
            { title: `${name} idn`, url: `https://bücher.example/${name}/1` },
            { title: `${name} other`, url: `https://example.org/${name}/2` },
          ],
        };
      }
      if (query.startsWith("junk:")) {
        const bad: WebSearchResult[] = [
          { title: `${name} relative`, url: "/relative/path" },
          { title: `${name} script`, url: "javascript:alert(1)" },
          { title: `${name} ftp`, url: "ftp://example.com/file" },
          { title: "", url: "https://example.com/untitled" },
        ];
        if (query.startsWith("junk:all")) return { results: bad };
        return {
          results: [
            ...bad,
            { title: `${name} first`, url: "https://example.com/dup" },
            { title: `${name} again`, url: "https://example.com/dup" },
          ],
        };
      }
      if (query.startsWith("big:")) {
        const n = Number.parseInt(query.slice("big:".length), 10) || 0;
        return {
          results: Array.from({ length: n }, (_, i) => ({
            title: `${name} result ${i + 1}`,
            url: `https://example.com/${name}/${i + 1}`,
            snippet: `${name} snippet ${i + 1} for ${query}`,
          })),
        };
      }
      const hosts = ["docs.example.com", "example.org", "www.example.net"];
      const results: WebSearchResult[] = hosts.map((h, i) => ({
        title: `${name} result ${i + 1}`,
        url: `https://${h}/${name}/${i + 1}`,
        snippet: `${name} snippet ${i + 1} for ${query}`,
        publishedAt: "2026-11-01",
      }));
      return { results };
    },
  };
  const fetch: WebFetchProvider = {
    configured,
    async fetch({ url, signal }): Promise<WebFetchPage> {
      fakeWebProbe().calls.push({ provider: name, op: "fetch", input: url });
      const script = fetchScript(url);
      await scriptedFailure(name, script, signal);
      if (script.startsWith("redirect-long:")) {
        const n = Number.parseInt(script.slice("redirect-long:".length), 10) || 0;
        const finalUrl = `https://example.com/${"a".repeat(n)}`;
        return { finalUrl, title: `${name} redirect`, markdown: "Moved." };
      }
      if (script.startsWith("redirect:")) {
        const finalUrl = script.slice("redirect:".length);
        return { finalUrl, title: `${name} redirect`, markdown: `Moved to ${finalUrl}.` };
      }
      if (script.startsWith("empty:")) return { finalUrl: url, markdown: "" };
      if (script.startsWith("big:")) {
        const n = Number.parseInt(script.slice("big:".length), 10) || 0;
        return { finalUrl: url, title: `${name} big page`, markdown: "x".repeat(n) };
      }
      return {
        finalUrl: url,
        title: `${name} page`,
        markdown: `# Page from ${name}\n\nFetched ${url} with ${name}.`,
        contentType: "text/html",
      };
    },
  };
  return { search, fetch };
}
