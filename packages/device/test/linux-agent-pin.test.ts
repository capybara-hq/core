import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINUX_DEVICE_AGENT } from "../src/exec/linux-agent.js";

// The Linux agent pins every granted root as an open descriptor; near its open-file limit (machine
// reach carves up to MAX_CARVED_READ_ROOTS roots) a pin fails with EMFILE. That refusal must say
// so and how to narrow the reach, not claim the root is not a directory.

const python = spawnSync("python3", ["--version"]).status === 0;
// O_PATH is Linux only: the file-root pins run where the agent runs
const linux = python && process.platform === "linux";

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
  "import errno, os, resource, stat",
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
for name in ("pin", "pin_read") + (("pin_file",) if sys.argv[3] == "1" else ()):
    try:
        agent[name](target if name != "pin_file" else target + "/file")
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
    writeFileSync(join(dir, "file"), "f");
    const run = spawnSync("python3", ["-I", "-c", PROGRAM, AGENT_PINS, dir, linux ? "1" : "0"], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, [string, string] | null>;
    for (const name of ["pin", "pin_read", ...(linux ? ["pin_file"] : [])]) {
      const [code, message] = out[name] ?? [];
      expect(code, name).toBe("SCOPE_DENIED");
      expect(message, name).toContain("open-file limit");
      expect(message, name).toContain("capybara-device ceiling set --project-reach paths");
      expect(message, name).not.toContain("not a directory");
    }
  });

  it.runIf(linux)(
    "pins a file root only as a regular file with one name at its canonical path",
    () => {
      writeFileSync(join(dir, "file"), "f");
      mkdirSync(join(dir, "sub"));
      symlinkSync(join(dir, "file"), join(dir, "link"));
      symlinkSync(dir, join(dir, "dirlink"));
      writeFileSync(join(dir, "twice"), "t");
      linkSync(join(dir, "twice"), join(dir, "twice2"));
      spawnSync("mkfifo", [join(dir, "fifo")]);
      const program = `
import json, os, sys
agent = {"__name__": "capybara_agent"}
exec(sys.argv[1], agent)
out = {}
for name in sys.argv[2:]:
    try:
        entry = agent["pin_file"](name)
        if entry is not None:
            info = os.stat(name, follow_symlinks=False)
            ok = [entry["dev"], entry["ino"]] == [info.st_dev, info.st_ino] and entry["path"] == name
            os.close(entry["fd"])
            out[name] = "pinned" if ok else "wrong"
        else:
            out[name] = None
    except agent["Refused"] as error:
        out[name] = error.code
print(json.dumps(out))
`;
      const names = ["file", "sub", "link", "dirlink/file", "twice", "fifo", "missing"].map((n) =>
        join(dir, n),
      );
      const run = spawnSync(
        "python3",
        ["-I", "-c", program, AGENT_PINS, ...names, `${dir}/./file`, "relative"],
        { encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        [join(dir, "file")]: "pinned",
        [join(dir, "sub")]: null, // a directory
        [join(dir, "link")]: null, // a symbolic link, not followed
        [join(dir, "dirlink/file")]: null, // reached through a link: not canonical
        [join(dir, "twice")]: null, // a second name (hard link)
        [join(dir, "fifo")]: null,
        [join(dir, "missing")]: null,
        [`${dir}/./file`]: "SCOPE_DENIED",
        relative: "SCOPE_DENIED",
      });
    },
  );

  it.runIf(python)("raises the soft open-file limit to fit the roots, up to the hard limit", () => {
    const program = `
import json, resource, sys
agent = {"__name__": "capybara_agent"}
exec(sys.argv[1], agent)
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (64, hard))
agent["raise_open_file_limit"]({"readRoots": ["/a"] * 1000, "writeRoots": ["/w"],
                                "readFileRoots": ["/f"] * 500})
now = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
want = 1501 + 256 if hard == resource.RLIM_INFINITY else min(hard, 1501 + 256)
print(json.dumps([now, want]))
`;
    const run = spawnSync("python3", ["-I", "-c", program, AGENT_PINS], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const [now, want] = JSON.parse(run.stdout) as [number, number];
    expect(now).toBe(want);
  });

  it.runIf(linux)("drops file roots past the open-file limit instead of failing", () => {
    for (let i = 0; i < 400; i++) writeFileSync(join(dir, `f${i}`), "f");
    const program = `
import json, os, resource, sys
agent = {"__name__": "capybara_agent"}
exec(sys.argv[1], agent)
d = sys.argv[2]
resource.setrlimit(resource.RLIMIT_NOFILE, (320, 320))  # a hard limit below the roots' need
request = {"readRoots": [d], "writeRoots": [], "readFileRoots": ["%s/f%d" % (d, i) for i in range(400)]}
agent["raise_open_file_limit"](request)
read = [agent["pin"](d)]
files = agent["pin_file_roots"](request)
held = len(os.listdir("/proc/self/fd"))
print(json.dumps({"dirs": len(read), "files": len(files), "free": 320 - held}))
`;
    const run = spawnSync("python3", ["-I", "-c", program, AGENT_PINS, dir], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { dirs: number; files: number; free: number };
    expect(out.dirs).toBe(1);
    expect(out.files).toBeGreaterThan(0);
    expect(out.files).toBeLessThan(400);
    expect(out.free).toBeGreaterThanOrEqual(256); // the reserve stays free
  });
});
