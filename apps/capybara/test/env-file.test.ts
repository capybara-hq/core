import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/args.js";
import { loadEnvFile, takeEnvFileOption } from "../src/env-file.js";

describe("takeEnvFileOption", () => {
  it("leaves the arguments alone without the option", () => {
    expect(takeEnvFileOption(["start", "--role", "api"])).toEqual({
      argv: ["start", "--role", "api"],
    });
  });

  it("takes --env-file anywhere, in both spellings", () => {
    expect(takeEnvFileOption(["--env-file", "a.env", "start"])).toEqual({
      argv: ["start"],
      file: "a.env",
    });
    expect(takeEnvFileOption(["start", "--env-file=b.env", "--role", "api"])).toEqual({
      argv: ["start", "--role", "api"],
      file: "b.env",
    });
  });

  it("--no-env-file turns loading off", () => {
    expect(takeEnvFileOption(["migrate", "--no-env-file"])).toEqual({
      argv: ["migrate"],
      file: null,
    });
  });

  it("refuses a missing path and a repeated option", () => {
    expect(() => takeEnvFileOption(["start", "--env-file"])).toThrow(UsageError);
    expect(() => takeEnvFileOption(["--env-file=", "start"])).toThrow(/needs a path/);
    expect(() => takeEnvFileOption(["--env-file", "a", "--no-env-file"])).toThrow(/more than once/);
  });

  it("stops at --", () => {
    expect(takeEnvFileOption(["x", "--", "--env-file", "a"])).toEqual({
      argv: ["x", "--", "--env-file", "a"],
    });
  });
});

describe("loadEnvFile", () => {
  function dir(files: Record<string, string> = {}): string {
    const d = mkdtempSync(join(tmpdir(), "capybara-env-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
    return d;
  }

  it("loads .env from the working directory when present", () => {
    const d = dir({ ".env": "X=1\n" });
    const loaded: string[] = [];
    expect(loadEnvFile(undefined, d, (p) => loaded.push(p))).toBe(join(d, ".env"));
    expect(loaded).toEqual([join(d, ".env")]);
  });

  it("does nothing without .env or with --no-env-file", () => {
    const load = () => {
      throw new Error("must not load");
    };
    expect(loadEnvFile(undefined, dir(), load)).toBeUndefined();
    expect(loadEnvFile(null, dir({ ".env": "X=1\n" }), load)).toBeUndefined();
  });

  it("resolves --env-file against the working directory and requires it to exist", () => {
    const d = dir({ "dev.env": "X=1\n" });
    expect(loadEnvFile("dev.env", d, () => {})).toBe(join(d, "dev.env"));
    expect(() => loadEnvFile("missing.env", d, () => {})).toThrow(
      /env file not found: missing\.env/,
    );
  });

  it("variables already in the environment win over the file", () => {
    const d = dir({ ".env": "CAPYBARA_ENV_FILE_TEST_A=file\nCAPYBARA_ENV_FILE_TEST_B=file\n" });
    process.env.CAPYBARA_ENV_FILE_TEST_A = "shell";
    try {
      loadEnvFile(undefined, d);
      expect(process.env.CAPYBARA_ENV_FILE_TEST_A).toBe("shell");
      expect(process.env.CAPYBARA_ENV_FILE_TEST_B).toBe("file");
    } finally {
      delete process.env.CAPYBARA_ENV_FILE_TEST_A;
      delete process.env.CAPYBARA_ENV_FILE_TEST_B;
    }
  });
});
