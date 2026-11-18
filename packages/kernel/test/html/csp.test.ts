import { describe, expect, it } from "vitest";
import { htmlDocumentCsp } from "../../src/html/csp.js";
import { htmlContentType, isHtmlType } from "../../src/html/html-type.js";

/** File sharing spec §4: the HTML document's policy, content type and the HTML file rule. */

const CDN = "https://cdn.jsdelivr.net";

describe("htmlDocumentCsp", () => {
  it("is the spec §4 policy with the allowlist in script, style, font and img sources only", () => {
    expect(htmlDocumentCsp([CDN])).toBe(
      [
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
        "default-src 'none'",
        `script-src 'unsafe-inline' 'unsafe-eval' ${CDN}`,
        `style-src 'unsafe-inline' ${CDN}`,
        `font-src data: ${CDN}`,
        `img-src data: blob: ${CDN}`,
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
  });

  it("never grants same-origin or top navigation; blocks connections and foreign framing", () => {
    const csp = htmlDocumentCsp([CDN, "https://unpkg.com"]);
    expect(csp).toContain("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    const directives = csp.split("; ");
    const withCdn = directives.filter((d) => d.includes(CDN)).map((d) => d.split(" ")[0]);
    expect(withCdn).toEqual(["script-src", "style-src", "font-src", "img-src"]);
  });

  it("an empty allowlist leaves no trailing space", () => {
    const csp = htmlDocumentCsp([]);
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';");
    expect(csp).toContain("font-src data:; img-src data: blob:;");
  });

  it("drops an entry that is not a bare https origin (defence in depth: no directive injection)", () => {
    const csp = htmlDocumentCsp([CDN, "https://evil.example; connect-src *", "http://x.test", "*"]);
    expect(csp).toBe(htmlDocumentCsp([CDN]));
  });
});

describe("htmlContentType", () => {
  it("keeps the stored charset (lower case), else utf-8", () => {
    expect(htmlContentType("text/html; charset=GBK")).toBe("text/html; charset=gbk");
    expect(htmlContentType('text/html; charset="Shift_JIS"')).toBe("text/html; charset=shift_jis");
    expect(htmlContentType("text/html")).toBe("text/html; charset=utf-8");
    expect(htmlContentType("application/octet-stream")).toBe("text/html; charset=utf-8");
  });

  it("an invalid charset value falls back to utf-8", () => {
    expect(htmlContentType("text/html; charset=a b")).toBe("text/html; charset=utf-8");
    expect(htmlContentType("text/html; charset=x\r\nset-cookie: a")).toBe(
      "text/html; charset=utf-8",
    );
    expect(htmlContentType("text/html; charset=")).toBe("text/html; charset=utf-8");
  });
});

describe("isHtmlType", () => {
  it("base type text/html, or a .html / .htm name in any case", () => {
    expect(isHtmlType("report.html", "text/plain")).toBe(true);
    expect(isHtmlType("REPORT.HTM", "application/octet-stream")).toBe(true);
    expect(isHtmlType("page", "Text/HTML; charset=utf-8")).toBe(true);
    expect(isHtmlType("data.csv", "text/csv")).toBe(false);
    expect(isHtmlType("x.xhtml", "application/xhtml+xml")).toBe(false);
    expect(isHtmlType("html", "text/plain")).toBe(false);
  });
});
