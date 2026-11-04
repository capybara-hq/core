import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchScript, newTaskId, startedText } from "../../src/background/launch.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";

/** The launch of a background Bash task (spec 2026-11-05-background-bash-design §4.2). */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-bg-launch-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const limits = { cpu: 1, memoryMb: 1, diskMb: 1, egress: "none" as const, allowHosts: [] };
const sig = () => AbortSignal.timeout(10_000);

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("newTaskId", () => {
  it("is bt_ plus 6 lowercase base32 characters, different each time", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTaskId()));
    for (const id of ids) expect(id).toMatch(/^bt_[a-z2-7]{6}$/);
    expect(ids.size).toBeGreaterThan(195);
  });
});

describe("startedText", () => {
  it("is spec §2.1's text", () => {
    expect(startedText("bt_k3f9a2", "Start the dev server")).toBe(
      'Started background task bt_k3f9a2 ("Start the dev server").\n' +
        "Output: /workspace/.capybara/tasks/bt_k3f9a2.out\n" +
        "Read it with TaskOutput (or Read), stop it with TaskStop. You will be told when it finishes.",
    );
  });
});

describe("launchScript", { timeout: 30_000 }, () => {
  it("starts the command detached under timeout -s KILL, output and exit status in task files", () => {
    const s = launchScript("bt_abcdef", "echo hi", 60);
    expect(s).toContain(
      "setsid nohup sh -c 'timeout -s KILL 60 bash .capybara/tasks/bt_abcdef.sh; echo $? > .capybara/tasks/bt_abcdef.exit' > .capybara/tasks/bt_abcdef.out 2>&1 < /dev/null &\necho $!",
    );
    // the command travels base64, never quoted by hand
    expect(s).toContain(Buffer.from("echo hi").toString("base64"));
    expect(s).not.toContain("echo hi");
  });

  it("runs a command with quotes, $, a backtick, newlines and a heredoc byte for byte", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-launch", image: "i", limits, signal: sig() });
    const command = [
      `echo 'single "double" $HOME' "it's \`echo tick\`"`,
      "X=1; echo \"x=$X\" '$X'",
      "cat <<'EOF'",
      "literal $HOME `not run` 'q' \"dq\"",
      "EOF",
      "cat <<EOF",
      "expanded $X",
      "EOF",
      "printf 'no newline at end'",
    ].join("\n");
    const run = (c: string) =>
      p.exec(h, {
        command: c,
        cwd: "/workspace",
        timeoutMs: 10_000,
        maxOutputBytes: 100_000,
        signal: sig(),
      });

    const fg = await run(command);
    expect(fg).toMatchObject({ exitCode: 0, stderr: "" });
    expect(fg.stdout).toContain("literal $HOME `not run`");

    const t0 = Date.now();
    const r = await run(launchScript("bt_rtrip2", command, 60));
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
    expect(Date.now() - t0).toBeLessThan(5000);

    const dir = join(root, "instances", h.id, "fs", "workspace", ".capybara", "tasks");
    await until(() => existsSync(join(dir, "bt_rtrip2.exit")));
    expect(await readFile(join(dir, "bt_rtrip2.sh"), "utf8")).toBe(command);
    expect(await readFile(join(dir, "bt_rtrip2.out"), "utf8")).toBe(fg.stdout);
    expect(await readFile(join(dir, "bt_rtrip2.exit"), "utf8")).toBe("0\n");
  });

  it("runs the command with bash, as a foreground Bash call does", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-launch-b", image: "i", limits, signal: sig() });
    const r = await p.exec(h, {
      command: launchScript("bt_bash22", "[[ 1 == 1 ]] && echo ok; echo {1..3}", 60),
      cwd: "/workspace",
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      signal: sig(),
    });
    expect(r.exitCode).toBe(0);
    const dir = join(root, "instances", h.id, "fs", "workspace", ".capybara", "tasks");
    await until(() => existsSync(join(dir, "bt_bash22.exit")));
    expect(await readFile(join(dir, "bt_bash22.out"), "utf8")).toBe("ok\n1 2 3\n");
    expect(await readFile(join(dir, "bt_bash22.exit"), "utf8")).toBe("0\n");
  });

  it("refuses an id that is not a task id and seconds that are not a positive integer", () => {
    for (const id of ["bt_ABCDEF", "bt_abc", "bt_abcdef; rm -rf /", "x_abcdef", "bt_abcde1"]) {
      expect(() => launchScript(id, "true", 60)).toThrow("invalid background task id");
    }
    for (const seconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => launchScript("bt_abcdef", "true", seconds)).toThrow(
        "invalid background task seconds",
      );
    }
  });

  it("writes the exit status of a failing command and kills one past its seconds (137)", async () => {
    const p = createFakeSandbox(root);
    const h = await p.create({ name: "cap-launch-x", image: "i", limits, signal: sig() });
    const run = (c: string) =>
      p.exec(h, {
        command: c,
        cwd: "/workspace",
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
        signal: sig(),
      });
    expect(
      (await run(launchScript("bt_fail22", "echo out; echo err >&2; exit 3", 60))).exitCode,
    ).toBe(0);
    expect((await run(launchScript("bt_slow22", "sleep 30", 1))).exitCode).toBe(0);
    const dir = join(root, "instances", h.id, "fs", "workspace", ".capybara", "tasks");
    await until(() => existsSync(join(dir, "bt_fail22.exit")));
    expect(await readFile(join(dir, "bt_fail22.exit"), "utf8")).toBe("3\n");
    expect(await readFile(join(dir, "bt_fail22.out"), "utf8")).toBe("out\nerr\n");
    await until(() => existsSync(join(dir, "bt_slow22.exit")));
    expect(await readFile(join(dir, "bt_slow22.exit"), "utf8")).toBe("137\n");
  });
});
