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

  it("admin create", () => {
    expect(parseCli(["admin", "create", "--login", "root", "--display-name", "Root"])).toEqual({
      command: "admin-create",
      login: "root",
      displayName: "Root",
    });
    expect(
      parseCli(["admin", "create", "--login=root", "--display-name=Root", "--email", "r@x.io"]),
    ).toEqual({ command: "admin-create", login: "root", displayName: "Root", email: "r@x.io" });
    expect(() => parseCli(["admin", "create", "--display-name", "R"])).toThrow(/--login/);
    expect(() => parseCli(["admin", "create", "--login", "r"])).toThrow(/--display-name/);
    expect(() => parseCli(["admin"])).toThrow(UsageError);
    expect(() => parseCli(["admin", "delete", "--login", "r"])).toThrow(/unknown admin command/);
    expect(() =>
      parseCli(["admin", "create", "--login", "r", "--display-name", "R", "--password", "x"]),
    ).toThrow(UsageError);
    expect(() => parseCli(["admin", "create", "--login", "r", "--display-name", "R", "x"])).toThrow(
      /unexpected argument/,
    );
    expect(() => parseCli(["start", "--login", "r"])).toThrow(/only valid for admin create/);
    expect(() => parseCli(["admin", "create", "--role", "api"])).toThrow(/only valid for start/);
  });

  it("plugins review / approve", () => {
    expect(parseCli(["plugins", "review"])).toEqual({ command: "plugins-review" });
    expect(parseCli(["plugins", "approve", "todo"])).toEqual({
      command: "plugins-approve",
      name: "todo",
      yes: false,
    });
    expect(parseCli(["plugins", "approve", "todo", "--yes"])).toEqual({
      command: "plugins-approve",
      name: "todo",
      yes: true,
    });
    expect(parseCli(["plugins", "approve", "-y", "todo"])).toMatchObject({ yes: true });
    expect(() => parseCli(["plugins"])).toThrow(/missing plugins command/);
    expect(() => parseCli(["plugins", "remove", "x"])).toThrow(/unknown plugins command/);
    expect(() => parseCli(["plugins", "approve"])).toThrow(/plugin name/);
    expect(() => parseCli(["plugins", "approve", "a", "b"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["plugins", "review", "x"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["plugins", "review", "--yes"])).toThrow(
      /only valid for plugins approve/,
    );
    expect(() => parseCli(["plugins", "review", "--role", "api"])).toThrow(/only valid for start/);
    expect(() => parseCli(["plugins", "approve", "a", "--login", "r"])).toThrow(
      /only valid for admin create/,
    );
    expect(() => parseCli(["start", "--yes"])).toThrow(/only valid for plugins approve/);
    expect(() =>
      parseCli(["admin", "create", "--login", "r", "--display-name", "R", "--yes"]),
    ).toThrow(/only valid for plugins approve/);
  });

  it("plugins list / install / enable / disable / uninstall", () => {
    expect(parseCli(["plugins", "list"])).toEqual({ command: "plugins-list" });
    expect(parseCli(["plugins", "install", "./life.tgz"])).toEqual({
      command: "plugins-install",
      target: "./life.tgz",
    });
    expect(parseCli(["plugins", "install", "npm:@acme/plugin-x@1.2.3"])).toEqual({
      command: "plugins-install",
      target: "npm:@acme/plugin-x@1.2.3",
    });
    for (const action of ["enable", "disable", "uninstall"] as const) {
      expect(parseCli(["plugins", action, "life"])).toEqual({
        command: "plugins-state",
        name: "life",
        action,
      });
      expect(() => parseCli(["plugins", action])).toThrow(/plugin name/);
      expect(() => parseCli(["plugins", action, "a", "b"])).toThrow(/unexpected argument/);
      expect(() => parseCli(["plugins", action, "a", "--yes"])).toThrow(
        /only valid for plugins approve/,
      );
    }
    expect(() => parseCli(["plugins", "install"])).toThrow(/needs a package/);
    expect(() => parseCli(["plugins", "list", "x"])).toThrow(/unexpected argument/);
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
