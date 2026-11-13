import { describe, expect, it } from "vitest";
import {
  GIT_HOST_USERNAMES,
  parseConnectorTemplateFile,
  parseGitSource,
  validateGitSource,
} from "../src/index.js";

const ok = (host: string, username = "x-access-token") => ({ hosts: [{ host, username }] });

describe("git source", () => {
  it("accepts valid hosts and documents the GitHub username", () => {
    expect(validateGitSource(ok("github.com"))).toEqual([]);
    expect(validateGitSource(ok("git.example.co.uk", "ci_bot-1.x"))).toEqual([]);
    expect(GIT_HOST_USERNAMES["github.com"]).toBe("x-access-token");
    expect(GIT_HOST_USERNAMES["*.ghe.com"]).toBe("x-access-token");
    expect(parseGitSource(ok("github.com"))).toEqual(ok("github.com"));
  });

  it.each([
    ["a port", "github.com:443"],
    ["a path", "github.com/org"],
    ["a scheme", "https://github.com"],
    ["userinfo", "user:ghp_SECRET123@github.com"],
    ["a wildcard", "*.ghe.com"],
    ["upper case", "GitHub.com"],
    ["an IP literal", "10.0.0.1"],
    ["an internal domain", "git.internal"],
    ["an empty host", ""],
  ])("refuses %s without echoing it", (_n, host) => {
    const errs = validateGitSource(ok(host));
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) expect(e).not.toContain("SECRET123");
  });

  it("refuses bad usernames without echoing them", () => {
    for (const u of ["", "a b", "ghp_x/y", "a".repeat(65), "tok:en"]) {
      const errs = validateGitSource(ok("github.com", u));
      expect(errs.length).toBeGreaterThan(0);
      if (u.length > 0) for (const e of errs) expect(e).not.toContain(u);
    }
  });

  it("refuses duplicates, empty and more than 8 hosts", () => {
    const e = { host: "github.com", username: "u" };
    expect(validateGitSource({ hosts: [e, e] }).join("\n")).toContain("duplicate host");
    expect(validateGitSource({ hosts: [] })).not.toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({
      host: `h${i}.example.com`,
      username: "u",
    }));
    expect(validateGitSource({ hosts: many })).not.toEqual([]);
    expect(validateGitSource({ hosts: many.slice(0, 8) })).toEqual([]);
  });

  it("refuses unknown keys, including a token", () => {
    expect(
      validateGitSource({ hosts: ok("github.com").hosts, token: "ghp_SECRET123" }),
    ).not.toEqual([]);
    const errs = validateGitSource({
      hosts: [{ host: "github.com", username: "u", password: "p" }],
    });
    expect(errs).not.toEqual([]);
    expect(parseGitSource("x")).toHaveProperty("errors");
  });
});

describe("connector template git field", () => {
  const file = (git: unknown) => ({
    displayName: { zh: "GitHub", en: "GitHub" },
    template: {
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://x.example.com/mcp" },
      auth: { type: "bearer", ownership: "org" },
      git,
    },
  });

  it("parses a valid git field and refuses an invalid one", () => {
    const good = parseConnectorTemplateFile(file(ok("github.com")));
    expect("errors" in good ? good.errors : []).toEqual([]);
    const bad = parseConnectorTemplateFile(file(ok("github.com:443")));
    expect("errors" in bad ? bad.errors.join("\n") : "").toContain("template.git.hosts.0.host");
  });
});
