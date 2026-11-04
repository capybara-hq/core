import { describe, expect, it } from "vitest";
import { normalizeFetchUrl } from "../../src/tools/builtins/web/url.js";

/** Web tools spec §7.1: the URL rules of `WebFetch` (pure, no DNS). */

const ACTION_VERB = /\b(?:use|call|retry|check|ask|pass|provide|read)\b/i;

describe("normalizeFetchUrl", () => {
  it.each([
    ["http://example.com/a", "https://example.com/a"],
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["  https://Example.COM/x  ", "https://example.com/x"],
  ])("%s → %s", (raw, url) => {
    expect(normalizeFetchUrl(raw)).toEqual({ ok: true, url });
  });

  it.each([
    ["ftp://x", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["not a url", "invalid"],
    ["/relative/path", "invalid"],
    ["https://user:pw@example.com", "credentials"],
    ["https://user@example.com", "credentials"],
    ["https://10.0.0.1/", "private"],
    ["https://localhost/", "private"],
    ["https://127.0.0.1:8080/", "private"],
    ["https://0x7f.0.0.1/", "private"],
    ["https://[::1]/", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://intranet/", "private"],
    [`https://example.com/${"a".repeat(2001 - "https://example.com/".length)}`, "length"],
  ])("%s → rejected (%s), with an actionable English error", (raw) => {
    const r = normalizeFetchUrl(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(ACTION_VERB);
    expect(r.error).not.toMatch(/[一-鿿]/);
  });

  it("the exact text of a private host", () => {
    expect(normalizeFetchUrl("https://10.0.0.1/")).toEqual({
      ok: false,
      error: "Pass a full public https URL; this host is private or local.",
    });
  });

  it("2000 characters pass, 2001 do not", () => {
    const base = "https://example.com/";
    const at = (n: number) => `${base}${"a".repeat(n - base.length)}`;
    expect(at(2000)).toHaveLength(2000);
    expect(normalizeFetchUrl(at(2000)).ok).toBe(true);
    expect(normalizeFetchUrl(at(2001)).ok).toBe(false);
  });

  it("the limit applies to the normalized URL: http of 2000 characters is 2001 after the upgrade", () => {
    const base = "http://example.com/";
    const raw = `${base}${"a".repeat(2000 - base.length)}`;
    expect(raw).toHaveLength(2000);
    expect(normalizeFetchUrl(raw)).toEqual({
      ok: false,
      error: "Pass a URL of at most 2000 characters.",
    });
    // one shorter fits after the upgrade
    expect(normalizeFetchUrl(raw.slice(0, -1)).ok).toBe(true);
  });
});
