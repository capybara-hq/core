import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINUX_DEVICE_AGENT } from "../src/exec/linux-agent.js";

// The Linux agent pins every granted root as an open descriptor; near its open-file limit (machine
// reach carves up to MAX_CARVED_READ_ROOTS roots) a pin fails with EMFILE. That refusal must say
// so and how to narrow the reach, not claim the root is not a directory.

const python = spawnSync("python3", ["--version"]).status === 0;

/** The agent's source from the line holding start up to (not including) end. */
function block(start: string, end: string): string {
  const from = LINUX_DEVICE_AGENT.indexOf(start);
  const to = LINUX_DEVICE_AGENT.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`the agent has no block from ${start} to ${end}`);
  return LINUX_DEVICE_AGENT.slice(from, to);
}

/**
 * The agent's Refused and its pinned-roots block (the whole agent does not load off Linux), run
 * after using up the open-file limit: pins `dir` both ways.
 */
const AGENT_PINS = [
  "import errno, os, stat",
  block("class Refused(Exception):", "def send(event):"),
  block("# ---- pinned roots", "def establish(path):"),
].join("\n");
const PROGRAM = `
import json, os, resource, sys
agent = {"__name__": "capybara_agent"}
exec(sys.argv[1], agent)
target = sys.argv[2]
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (64, hard))
held = []
try:
    while True:
        held.append(os.open(target, os.O_RDONLY))
except OSError:
    pass
out = {}
for name in ("pin", "pin_read"):
    try:
        agent[name](target)
        out[name] = None
    except agent["Refused"] as error:
        out[name] = [error.code, str(error)]
print(json.dumps(out))
`;

describe("the Linux agent's root pins", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-pin-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // python3 is a prerequisite of the device's Linux runtime; CI's Linux runners have it
  it.runIf(python)("refuses with the open-file limit and how to narrow the reach on EMFILE", () => {
    const run = spawnSync("python3", ["-I", "-c", PROGRAM, AGENT_PINS, dir], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, [string, string] | null>;
    for (const name of ["pin", "pin_read"]) {
      const [code, message] = out[name] ?? [];
      expect(code, name).toBe("SCOPE_DENIED");
      expect(message, name).toContain("open-file limit");
      expect(message, name).toContain("capybara-device ceiling set --project-reach paths");
      expect(message, name).not.toContain("not a directory");
    }
  });
});
