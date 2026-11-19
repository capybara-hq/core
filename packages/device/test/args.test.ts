import { describe, expect, it } from "vitest";
import { parseCommandLine, UsageError } from "../src/args.js";

describe("parseCommandLine", () => {
  it("login --json sets browser false and json", () => {
    expect(parseCommandLine(["login", "--url", "u", "--json"])).toEqual({
      command: "login",
      url: "u",
      browser: false,
      mode: "os",
      json: true,
    });
  });

  it("parses --json for ceiling show and service status only", () => {
    expect(parseCommandLine(["ceiling", "show", "--json"])).toEqual({
      command: "ceiling",
      action: "show",
      json: true,
    });
    expect(parseCommandLine(["service", "status", "--json"])).toEqual({
      command: "service",
      action: "status",
      json: true,
    });
    expect(() => parseCommandLine(["service", "start", "--json"])).toThrow(UsageError);
    expect(() =>
      parseCommandLine([
        "ceiling",
        "set",
        "--full-access",
        "allow",
        "--project-reach",
        "workspace",
        "--json",
      ]),
    ).toThrow(UsageError);
  });

  it("parses login flags with defaults", () => {
    expect(parseCommandLine(["login", "--url", "https://x.test"])).toEqual({
      command: "login",
      url: "https://x.test",
      browser: true,
      mode: "os",
    });
    expect(
      parseCommandLine(["login", "--url", "u", "--no-browser", "--dir", "/d", "--mode", "docker"]),
    ).toEqual({ command: "login", url: "u", browser: false, dir: "/d", mode: "docker" });
  });

  it("rejects bad input", () => {
    expect(() => parseCommandLine(["login"])).toThrow(UsageError);
    expect(() => parseCommandLine(["login", "--url", "u", "--mode", "vm"])).toThrow(UsageError);
    expect(() => parseCommandLine(["nope"])).toThrow(/unknown command/);
    expect(() => parseCommandLine(["status", "--bogus"])).toThrow(UsageError);
  });

  it("parses the other commands", () => {
    expect(parseCommandLine(["status", "--json"])).toEqual({ command: "status", json: true });
    expect(parseCommandLine(["logout"])).toEqual({ command: "logout" });
    expect(parseCommandLine(["drain"])).toEqual({ command: "drain" });
    expect(parseCommandLine(["drain", "--wait"])).toEqual({ command: "drain", wait: true });
    expect(parseCommandLine(["drain", "--wait", "--timeout", "30"])).toEqual({
      command: "drain",
      wait: true,
      timeoutSeconds: 30,
    });
    expect(() => parseCommandLine(["drain", "--timeout", "30"])).toThrow(/--timeout needs --wait/);
    expect(() => parseCommandLine(["drain", "--wait", "--timeout", "0"])).toThrow(UsageError);
    expect(() => parseCommandLine(["drain", "--wait", "--timeout", "x"])).toThrow(UsageError);
    expect(() => parseCommandLine(["drain", "now"])).toThrow(UsageError);
    expect(parseCommandLine(["policy"])).toEqual({ command: "policy", action: "show" });
    expect(parseCommandLine(["policy", "show"])).toEqual({ command: "policy", action: "show" });
    expect(parseCommandLine(["policy", "set", "cpu", "2"])).toEqual({
      command: "policy",
      action: "set",
      key: "cpu",
      value: "2",
    });
    expect(parseCommandLine(["policy", "add", "allowedDomains", "a.com"])).toEqual({
      command: "policy",
      action: "add",
      key: "allowedDomains",
      value: "a.com",
    });
    expect(parseCommandLine(["policy", "remove", "allowedDomains", "a.com"])).toEqual({
      command: "policy",
      action: "remove",
      key: "allowedDomains",
      value: "a.com",
    });
    // `--yes` is gone from policy: widening is confirmed by `ceiling set`.
    expect(() => parseCommandLine(["policy", "set", "isolation", "none", "--yes"])).toThrow(
      UsageError,
    );
    expect(() => parseCommandLine(["policy", "--yes"])).toThrow(UsageError);
    expect(() => parseCommandLine(["policy", "add", "allowedDomains"])).toThrow(UsageError);
    expect(() => parseCommandLine(["policy", "remove", "a", "b", "c"])).toThrow(UsageError);
    // the daily mode command is gone: the owner ceiling replaced it
    for (const argv of [["mode"], ["mode", "auto"], ["mode", "sandbox", "-y"]])
      expect(() => parseCommandLine(argv)).toThrow(/unknown command mode/);
    expect(parseCommandLine(["service", "install"])).toEqual({
      command: "service",
      action: "install",
    });
    expect(parseCommandLine(["service", "status"])).toEqual({
      command: "service",
      action: "status",
    });
    expect(() => parseCommandLine(["service"])).toThrow(UsageError);
    expect(() => parseCommandLine(["service", "status", "now"])).toThrow(UsageError);
    expect(parseCommandLine([])).toEqual({ command: "help" });
  });
});
