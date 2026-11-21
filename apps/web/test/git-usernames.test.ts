import { describe, expect, it } from "vitest";
import { suggestGitUsernameForHost, suggestGitUsernameForUrl } from "../src/lib/git-usernames";

describe("git username suggestions", () => {
  it.each([
    ["github.com", "x-access-token"],
    ["octo.ghe.com", "x-access-token"],
    ["bitbucket.org", "x-token-auth"],
    ["gitlab.com", "oauth2"],
    ["GitLab.com", "oauth2"],
    ["gitee.com", undefined],
    ["git.example.com", undefined],
  ])("host %s -> %s (the table of packages/plugin-sdk/src/git-hosts.ts)", (host, want) => {
    expect(suggestGitUsernameForHost(host)).toBe(want);
  });

  it.each([
    ["https://bitbucket.org/acme/m.git", "x-token-auth"],
    ["https://github.com/acme/m", "x-access-token"],
    ["acme/market", undefined],
    ["git@gitlab.com:acme/m.git", "oauth2"],
    ["https://gitee.com/acme/m.git", undefined],
    ["", undefined],
    ["not a url", undefined],
  ])("address %s -> %s", (url, want) => {
    expect(suggestGitUsernameForUrl(url)).toBe(want);
  });
});
