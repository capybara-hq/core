import { ToolError, WebProviderError, type WebProviderErrorKind } from "@capybara-hq/plugin-sdk";

/** Which web tool is calling its provider (it names the provider in some texts). */
export type WebToolKind = "search" | "fetch";

const KINDS: ReadonlySet<string> = new Set<WebProviderErrorKind>([
  "not_found",
  "blocked",
  "auth",
  "rate_limited",
  "unavailable",
  "invalid",
]);

/**
 * The kind of a provider's `WebProviderError`, or undefined for any other error. Matched by name
 * as well as by class, so an extension bundled with its own copy of the class still maps.
 */
function providerErrorKind(e: unknown): WebProviderErrorKind | undefined {
  if (!(e instanceof Error)) return undefined;
  if (!(e instanceof WebProviderError) && e.name !== "WebProviderError") return undefined;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === "string" && KINDS.has(kind) ? (kind as WebProviderErrorKind) : undefined;
}

/**
 * The fixed model-visible text of a provider error kind (web tools spec §4.2): providers never
 * write model-visible text.
 */
function providerErrorText(kind: WebProviderErrorKind, tool: WebToolKind): string {
  const provider = tool === "search" ? "web search" : "web fetch";
  switch (kind) {
    case "auth":
      return `The ${provider} provider rejected its credentials; ask an org admin to check the provider's configuration.`;
    case "rate_limited":
      return `The ${provider} provider is rate limiting this org; retry in a minute or continue without it.`;
    case "not_found":
      return "No results or page found; check the query or URL and retry.";
    case "blocked":
      return "The site refused the provider; try another source.";
    case "unavailable":
      return "The web provider is unavailable right now; retry later or continue without it.";
    case "invalid":
      return "The provider rejected the request; check the query or URL and retry.";
  }
}

/**
 * Rethrows a web provider's failure for the tool pipeline: a `WebProviderError` becomes a
 * `ToolError` with its kind's fixed text; anything else is rethrown unchanged (the pipeline's
 * generic failure, which names only the error class, never the provider's message).
 */
export function webToolError(e: unknown, tool: WebToolKind): never {
  const kind = providerErrorKind(e);
  if (kind === undefined) throw e;
  throw new ToolError(providerErrorText(kind, tool));
}
