import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  AUTO_MODE_RISK_TEXT,
  MODE_AUTO_NEEDS_YES,
  MODE_AUTO_PROMPT,
  modeCommand,
} from "../src/commands/mode.js";
import { DEFAULT_POLICY, readPolicy, writePolicy } from "../src/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-mode-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (argv: string[], ask?: (q: string) => Promise<string>) => {
  const out: string[] = [];
  const err: string[] = [];
  const cmd = { command: "mode" as const, ...parse(argv) };
  return modeCommand(cmd, {
    stateDir: dir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(ask && { ask }),
  }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
};

const parse = (argv: string[]) => {
  const [which, ...rest] = argv;
  const yes = rest.includes("--yes");
  if (which === undefined) return {};
  return { mode: which as "auto" | "sandbox", ...(yes && { yes: true as const }) };
};

describe("capybara-device mode", () => {
  it("prints the current mode, auto by default", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Mode: auto.");
    expect(r.out).toMatch(/reviews every command/);
  });

  it("sets sandbox mode without a question", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "auto" });
    const r = await run(["sandbox"]);
    expect(r.code).toBe(0);
    expect(readPolicy(dir).mode).toBe("sandbox");
    expect(r.out).toMatch(/in the sandbox \(from the next command\)/);
    expect((await run([])).out).toContain("Mode: sandbox.");
  });

  it("auto mode prints the risk text and needs --yes without a terminal", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const r = await run(["auto"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe(AUTO_MODE_RISK_TEXT);
    expect(r.err).toBe(MODE_AUTO_NEEDS_YES);
    expect(readPolicy(dir).mode).toBe("sandbox");
  });

  it("auto mode with --yes prints the risk text once and sets it", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const r = await run(["auto", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(AUTO_MODE_RISK_TEXT);
    expect(readPolicy(dir).mode).toBe("auto");
  });

  it("on a terminal asks once: y sets it, anything else changes nothing", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, mode: "sandbox" });
    const questions: string[] = [];
    const yes = await run(["auto"], async (q) => {
      questions.push(q);
      return " y \n";
    });
    expect(yes.code).toBe(0);
    expect(questions).toEqual([MODE_AUTO_PROMPT]);
    expect(yes.out).toContain(AUTO_MODE_RISK_TEXT);
    expect(readPolicy(dir).mode).toBe("auto");
    const no = await run(["sandbox"]);
    expect(no.code).toBe(0);
    const refused = await run(["auto"], async () => "n");
    expect(refused.code).toBe(1);
    expect(refused.err).toBe("Nothing changed.");
    expect(readPolicy(dir).mode).toBe("sandbox");
  });

  it("the CLI routes mode; without a terminal and --yes it exits 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["mode", "auto"], {
      env: { XDG_CONFIG_HOME: dir },
      home: "/nonexistent",
      stdinIsTTY: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toBe(MODE_AUTO_NEEDS_YES);
    // The command parser accepts no other value.
    const bad = await runCli(["mode", "vm"], {
      env: { XDG_CONFIG_HOME: dir },
      home: "/nonexistent",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(bad).toBe(2);
  });

  it("the CLI with --yes applies it and applies at the next command", async () => {
    const out: string[] = [];
    const code = await runCli(["mode", "auto", "--yes"], {
      env: { XDG_CONFIG_HOME: dir },
      home: "/nonexistent",
      stdinIsTTY: false,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("now runs agent commands in auto mode");
  });
});
