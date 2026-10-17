import { describe, expect, it } from "vitest";
import { parseCli, UsageError } from "../src/args.js";

describe("parseCli", () => {
  it("start 与 --role", () => {
    expect(parseCli(["start"])).toEqual({ command: "start" });
    expect(parseCli(["start", "--role", "api,worker"])).toEqual({
      command: "start",
      roles: ["api", "worker"],
    });
    expect(parseCli(["start", "--role=worker, worker"])).toEqual({
      command: "start",
      roles: ["worker"],
    });
  });

  it("migrate 与 help", () => {
    expect(parseCli(["migrate"])).toEqual({ command: "migrate" });
    expect(parseCli([])).toEqual({ command: "help" });
    expect(parseCli(["start", "-h"])).toEqual({ command: "help" });
  });

  it("非法输入抛 UsageError", () => {
    expect(() => parseCli(["start", "--role", "db"])).toThrow(UsageError);
    expect(() => parseCli(["start", "--role", ","])).toThrow(/at least one/);
    expect(() => parseCli(["migrate", "--role", "api"])).toThrow(/only valid for start/);
    expect(() => parseCli(["deploy"])).toThrow(/unknown command/);
    expect(() => parseCli(["start", "--port", "1"])).toThrow(UsageError);
    expect(() => parseCli(["start", "extra"])).toThrow(/unexpected argument/);
  });
});
