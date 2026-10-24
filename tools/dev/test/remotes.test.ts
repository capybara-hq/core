import { describe, expect, it } from "vitest";
import { findUpstream, parseRemoteConfig } from "../src/remotes.ts";

describe("findUpstream", () => {
  it("origin pointing to capybara-hq/core is not a fork", () => {
    expect(
      findUpstream([{ name: "origin", url: "https://github.com/capybara-hq/core.git" }], "core"),
    ).toEqual({
      remote: "origin",
      fork: false,
    });
  });

  it("upstream pointing to capybara-hq/core via SSH is a fork", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/someone/core.git" },
      { name: "upstream", url: "git@github.com:Capybara-HQ/core" },
    ];
    expect(findUpstream(remotes, "core")).toEqual({ remote: "upstream", fork: true });
  });

  it("ssh:// URLs match, case-insensitively", () => {
    expect(
      findUpstream([{ name: "up", url: "ssh://git@github.com/Capybara-HQ/core.git" }], "core"),
    ).toEqual({ remote: "up", fork: true });
  });

  it("HTTPS URLs with embedded user info match", () => {
    const remotes = [{ name: "origin", url: "https://grant-chao@github.com/capybara-hq/core.git" }];
    expect(findUpstream(remotes, "core")).toEqual({ remote: "origin", fork: false });
  });

  it("no match returns null", () => {
    expect(
      findUpstream([{ name: "origin", url: "https://github.com/someone/core.git" }], "core"),
    ).toBeNull();
    expect(
      findUpstream(
        [{ name: "origin", url: "https://github.com/capybara-hq/core-extra.git" }],
        "core",
      ),
    ).toBeNull();
  });
});

describe("parseRemoteConfig", () => {
  it("handles dotted remote names", () => {
    expect(parseRemoteConfig("remote.my.fork.url git@github.com:me/core.git\n")).toEqual([
      { name: "my.fork", url: "git@github.com:me/core.git" },
    ]);
  });

  it("keeps the first url of a remote with several", () => {
    expect(
      parseRemoteConfig("remote.origin.url a\nremote.origin.url b\nremote.up.url c\n"),
    ).toEqual([
      { name: "origin", url: "a" },
      { name: "up", url: "c" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseRemoteConfig("")).toEqual([]);
  });
});
