import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/command-log.js";
import { policySummary } from "../src/server-ops.js";
import { DEFAULT_POLICY, FULL_OWNER_CEILING, ownerCeilingOfMode } from "../src/state.js";

/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };

describe("CommandLog", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotates at the size limit", () => {
    dir = mkdtempSync(join(tmpdir(), "device-log-"));
    writeFileSync(join(dir, "commands.log"), "x".repeat(100));
    const log = new CommandLog(dir, 100);
    log.append({ time: "t", op: "exec", tag: "a", actor: null, exitCode: 0 });
    expect(readFileSync(join(dir, "commands.log.1"), "utf8")).toBe("x".repeat(100));
    expect(readFileSync(join(dir, "commands.log"), "utf8")).toContain('"op":"exec"');
  });
});

describe("the policy summary", () => {
  it("reports the sandbox allowlist only, on the machine and in a container", () => {
    expect(
      policySummary({ ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("auto") }, { mode: "os" }),
    ).toEqual({ allowedDomains: [] });
    expect(
      policySummary(
        { ...FULL_POLICY, ownerCeiling: ownerCeilingOfMode("sandbox") },
        { mode: "docker" },
      ),
    ).toEqual({ allowedDomains: [] });
  });
});
