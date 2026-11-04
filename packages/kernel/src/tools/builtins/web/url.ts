import { isPublicHostname } from "@capybara-hq/plugin-sdk";

/** The longest URL `WebFetch` accepts, in characters (Claude Code's limit; web tools spec §7.1). */
export const MAX_FETCH_URL_CHARS = 2000;

/** The outcome of {@link normalizeFetchUrl}: the URL to fetch, or a model-visible error. */
export type FetchUrlCheck = { ok: true; url: string } | { ok: false; error: string };

const fail = (error: string): FetchUrlCheck => ({ ok: false, error });

/**
 * A `WebFetch` URL checked and normalized (web tools spec §7.1): absolute http(s), `http:`
 * upgraded to `https:`, no user name or password, at most {@link MAX_FETCH_URL_CHARS} characters
 * (before and after normalization), and a host that can name a public internet host. Pure, no DNS: a public name that resolves to a
 * private address is the provider's to refuse. Errors are English and tell the model what to pass.
 */
export function normalizeFetchUrl(raw: string): FetchUrlCheck {
  const input = raw.trim();
  // a cheap guard before parsing; the normalized URL is checked again below
  if (input.length > MAX_FETCH_URL_CHARS) {
    return fail(`Pass a URL of at most ${MAX_FETCH_URL_CHARS} characters.`);
  }
  let u: URL;
  try {
    // no base: a relative URL throws
    u = new URL(input);
  } catch {
    return fail("Pass a full absolute URL, such as https://example.com/page.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return fail("Pass an https URL; only http and https URLs can be fetched.");
  }
  if (u.username !== "" || u.password !== "") {
    return fail("Pass the URL without a user name or password.");
  }
  u.protocol = "https:";
  // `u.hostname` is WHATWG-normalized (lowercased, IDNA, numeric IPv4 forms such as `0x7f.0.0.1`
  // rewritten to dotted decimal, IPv6 in brackets), which is what isPublicHostname expects: never
  // pass it a hand-parsed host.
  if (!isPublicHostname(u.hostname)) {
    return fail("Pass a full public https URL; this host is private or local.");
  }
  // the limit is on the URL as fetched: the upgrade, IDNA and percent-encoding can lengthen it
  if (u.href.length > MAX_FETCH_URL_CHARS) {
    return fail(`Pass a URL of at most ${MAX_FETCH_URL_CHARS} characters.`);
  }
  return { ok: true, url: u.href };
}
