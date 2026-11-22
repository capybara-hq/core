import { OAUTH_RESERVED_AUTHORIZATION_PARAMS } from "@capybara-hq/plugin-sdk";

const RESERVED: ReadonlySet<string> = new Set(OAUTH_RESERVED_AUTHORIZATION_PARAMS);

/**
 * Appends a connector's `authorizationParams` to an authorize URL that already carries the
 * kernel's own parameters. The schema refuses reserved names on write; this checks again so a row
 * written by older code or by hand can never override a kernel name. Returns the names it skipped
 * (reserved, or not a string value) for the caller to log; values are never returned.
 */
export function appendAuthorizationParams(
  url: URL,
  params: Readonly<Record<string, string>> | undefined,
): string[] {
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(params ?? {})) {
    if (RESERVED.has(name.toLowerCase()) || typeof value !== "string") {
      skipped.push(name);
      continue;
    }
    url.searchParams.set(name, value);
  }
  return skipped;
}
