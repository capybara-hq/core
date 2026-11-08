import { describe, expect, it } from "vitest";
import { parseCommandLine, UsageError } from "../src/args.js";

describe("parseCommandLine", () => {
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
    expect(parseCommandLine(["policy"])).toEqual({ command: "policy", action: "show" });
    expect(parseCommandLine(["policy", "set", "cpu", "2"])).toEqual({
      command: "policy",
      action: "set",
      key: "cpu",
      value: "2",
    });
    expect(parseCommandLine(["service", "install"])).toEqual({
      command: "service",
      action: "install",
    });
    expect(() => parseCommandLine(["service"])).toThrow(UsageError);
    expect(parseCommandLine([])).toEqual({ command: "help" });
  });
});
