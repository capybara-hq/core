import { describe, expect, it } from "vitest";
import { parseCli, USAGE, UsageError } from "../src/args.js";

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
      ifNone: false,
    });
    expect(
      parseCli(["admin", "create", "--login=root", "--display-name=Root", "--email", "r@x.io"]),
    ).toEqual({
      command: "admin-create",
      login: "root",
      displayName: "Root",
      email: "r@x.io",
      ifNone: false,
    });
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

  it("admin create --if-none --password-file", () => {
    expect(
      parseCli([
        "admin",
        "create",
        "--login",
        "a",
        "--display-name",
        "A",
        "--if-none",
        "--password-file",
        "/run/secrets/pw",
      ]),
    ).toEqual({
      command: "admin-create",
      login: "a",
      displayName: "A",
      ifNone: true,
      passwordFile: "/run/secrets/pw",
    });
    expect(() =>
      parseCli(["admin", "create", "--login", "a", "--display-name", "A", "--password-file", ""]),
    ).toThrow(/--password-file/);
    for (const opt of [["--if-none"], ["--password-file", "/pw"]]) {
      expect(() => parseCli(["start", ...opt])).toThrow(/only valid for admin create/);
      expect(() => parseCli(["admin", "grant", "a", ...opt])).toThrow(
        /only valid for admin create/,
      );
      expect(() => parseCli(["extensions", "list", ...opt])).toThrow(/only valid for admin create/);
    }
  });

  it("admin grant / revoke <login>", () => {
    expect(parseCli(["admin", "grant", "alice"])).toEqual({
      command: "admin-grant",
      login: "alice",
      grant: true,
    });
    expect(parseCli(["admin", "revoke", "alice"])).toEqual({
      command: "admin-grant",
      login: "alice",
      grant: false,
    });
    expect(() => parseCli(["admin", "grant"])).toThrow(/needs a login/);
    expect(() => parseCli(["admin", "revoke", " "])).toThrow(/needs a login/);
    expect(() => parseCli(["admin", "grant", "a", "b"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["admin", "grant", "a", "--login", "b"])).toThrow(
      /only valid for admin create/,
    );
    expect(() => parseCli(["admin", "revoke", "a", "--role", "api"])).toThrow(
      /only valid for start/,
    );
    expect(() => parseCli(["admin", "grant", "a", "--yes"])).toThrow(UsageError);
  });

  it("extensions review / approve", () => {
    expect(parseCli(["extensions", "review"])).toEqual({ command: "extensions-review" });
    expect(parseCli(["extensions", "approve", "todo"])).toEqual({
      command: "extensions-approve",
      name: "todo",
      yes: false,
    });
    expect(parseCli(["extensions", "approve", "todo", "--yes"])).toEqual({
      command: "extensions-approve",
      name: "todo",
      yes: true,
    });
    expect(parseCli(["extensions", "approve", "-y", "todo"])).toMatchObject({ yes: true });
    expect(() => parseCli(["extensions"])).toThrow(/missing extensions command/);
    expect(() => parseCli(["extensions", "remove", "x"])).toThrow(/unknown extensions command/);
    expect(() => parseCli(["extensions", "approve"])).toThrow(/extension name/);
    expect(() => parseCli(["extensions", "approve", "a", "b"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["extensions", "review", "x"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["extensions", "review", "--yes"])).toThrow(
      /only valid for extensions approve and extensions install/,
    );
    expect(() => parseCli(["extensions", "review", "--role", "api"])).toThrow(
      /only valid for start/,
    );
    expect(() => parseCli(["extensions", "approve", "a", "--login", "r"])).toThrow(
      /only valid for admin create/,
    );
    expect(() => parseCli(["start", "--yes"])).toThrow(
      /only valid for extensions approve, extensions install and plugins import/,
    );
    expect(() =>
      parseCli(["admin", "create", "--login", "r", "--display-name", "R", "--yes"]),
    ).toThrow(/only valid for extensions approve, extensions install and plugins import/);
  });

  it("plugins manages the catalog; the extension subcommands are not plugins subcommands", () => {
    expect(parseCli(["plugins", "list"])).toEqual({ command: "plugins-list" });
    expect(parseCli(["plugins", "import", "./a.tgz"])).toEqual({
      command: "plugins-import",
      target: "./a.tgz",
      yes: false,
      deployExtension: false,
    });
    expect(
      parseCli(["plugins", "import", "npm:@acme/a@1.0.0", "--deploy-extension", "-y"]),
    ).toEqual({
      command: "plugins-import",
      target: "npm:@acme/a@1.0.0",
      yes: true,
      deployExtension: true,
    });
    for (const sub of ["approve", "review", "enable", "disable", "uninstall", "state"]) {
      expect(() => parseCli(["plugins", sub, "slack", "--yes"])).toThrow(UsageError);
    }
    expect(() => parseCli(["plugins"])).toThrow(/missing plugins command/);
    expect(() => parseCli(["plugins", "import"])).toThrow(/needs a package/);
    expect(() => parseCli(["plugins", "import", "a", "b"])).toThrow(/unexpected argument/);
    expect(() => parseCli(["plugins", "list", "--yes"])).toThrow(UsageError);
    expect(() => parseCli(["extensions", "install", "a", "--deploy-extension"])).toThrow(
      /only valid for plugins import/,
    );
    expect(USAGE).toContain("capybara extensions install");
    expect(USAGE).toContain("capybara plugins import");
  });

  it("extensions list / install / enable / disable / uninstall", () => {
    expect(parseCli(["extensions", "list"])).toEqual({ command: "extensions-list" });
    expect(parseCli(["extensions", "install", "./life.tgz"])).toEqual({
      command: "extensions-install",
      target: "./life.tgz",
      yes: false,
    });
    expect(parseCli(["extensions", "install", "./life.tgz", "--yes"])).toMatchObject({ yes: true });
    expect(parseCli(["extensions", "install", "npm:@acme/plugin-x@1.2.3"])).toEqual({
      command: "extensions-install",
      target: "npm:@acme/plugin-x@1.2.3",
      yes: false,
    });
    for (const action of ["enable", "disable", "uninstall"] as const) {
      expect(parseCli(["extensions", action, "life"])).toEqual({
        command: "extensions-state",
        name: "life",
        action,
      });
      expect(() => parseCli(["extensions", action])).toThrow(/extension name/);
      expect(() => parseCli(["extensions", action, "a", "b"])).toThrow(/unexpected argument/);
      expect(() => parseCli(["extensions", action, "a", "--yes"])).toThrow(
        /only valid for extensions approve and extensions install/,
      );
    }
    expect(() => parseCli(["extensions", "install"])).toThrow(/needs a package/);
    expect(() => parseCli(["extensions", "list", "x"])).toThrow(/unexpected argument/);
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
