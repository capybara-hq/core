import { describe, expect, it } from "vitest";
import { findUpstream } from "../src/remotes.ts";

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
