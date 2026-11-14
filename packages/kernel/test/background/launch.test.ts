import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_LAUNCH_LINE, isBackgroundLaunch } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GROUP_LAUNCHER,
  launchScript,
  newTaskId,
  SESSION_MODE_SCRIPT,
  startedText,
} from "../../src/background/launch.js";
import { killSessionScript, termScript } from "../../src/background/session.js";
import { createFakeSandbox, fakeWorkspaceDir } from "../fixtures/plugins/sandbox-fake/index.js";

/** The launch of a background Bash task (spec 2026-11-05-background-bash-design §4.2). */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-bg-launch-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const limits = {
  cpu: 1,
  memoryMb: 1,
  diskMb: 1,
  mode: "sandbox" as const,
  network: { kind: "allowlist" as const, hosts: [] },
};
const sig = () => AbortSignal.timeout(10_000);
const ACTOR = { accountId: "a", conversationId: "c" };

/** A fake instance on a file system of its own. */
async function instance(p: ReturnType<typeof createFakeSandbox>, name: string) {
  const fileSystem = await p.createFileSystem({ name, limits, signal: sig() });
  return p.create({ name, image: "i", limits, fileSystem, signal: sig() });
}

/** Waits until `cond` holds (the old polling loop's 10 s budget); an error surfaces. */
const until = (cond: () => boolean, ms = 10_000): Promise<unknown> =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met yet");
    },
    { timeout: ms },
  );

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

describe("launchScript", () => {
  it("starts the command detached under timeout -s KILL, output and exit status in task files", () => {
    const s = launchScript("bt_abcdef", "echo hi", 60);
    // a device leaves what a launch detaches running (it reaps every other exec's leftovers)
    expect(isBackgroundLaunch(s)).toBe(true);
    expect(s.startsWith(`${BACKGROUND_LAUNCH_LINE}\nset -e\n`)).toBe(true);
    expect(s).toContain(
      "setsid nohup sh -c 'timeout -s KILL 60 bash .capybara/tasks/bt_abcdef.sh; echo $? > .capybara/tasks/bt_abcdef.exit' > .capybara/tasks/bt_abcdef.out 2>&1 < /dev/null &\necho $! > .capybara/tasks/bt_abcdef.sid\n",
    );
    // without pgrep -s (macOS): the perl launcher, which writes the sid itself
    expect(s).toContain(
      `nohup perl -e '${GROUP_LAUNCHER}' 60 .capybara/tasks/bt_abcdef > .capybara/tasks/bt_abcdef.out 2>&1 < /dev/null &`,
    );
    expect(GROUP_LAUNCHER).not.toContain("'");
    expect(s.endsWith("\nfi\ncat .capybara/tasks/bt_abcdef.sid")).toBe(true);
    // the command travels base64, never quoted by hand
    expect(s).toContain(Buffer.from("echo hi").toString("base64"));
    expect(s).not.toContain("echo hi");
  });

  it("runs a command with quotes, $, a backtick, newlines and a heredoc byte for byte", async () => {
    const p = createFakeSandbox(root);
    const h = await instance(p, "cap-launch");
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
        tag: "test",
        actor: ACTOR,
      });

    const fg = await run(command);
    expect(fg).toMatchObject({ exitCode: 0, stderr: "" });
    expect(fg.stdout).toContain("literal $HOME `not run`");

    const t0 = Date.now();
    const r = await run(launchScript("bt_rtrip2", command, 60));
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
    expect(Date.now() - t0).toBeLessThan(5000);

    const dir = join(fakeWorkspaceDir(root, h.id), ".capybara", "tasks");
    await until(() => existsSync(join(dir, "bt_rtrip2.exit")));
    expect(await readFile(join(dir, "bt_rtrip2.sh"), "utf8")).toBe(command);
    expect(await readFile(join(dir, "bt_rtrip2.out"), "utf8")).toBe(fg.stdout);
    expect(await readFile(join(dir, "bt_rtrip2.exit"), "utf8")).toBe("0\n");
  });

  it("runs the command with bash, as a foreground Bash call does", async () => {
    const p = createFakeSandbox(root);
    const h = await instance(p, "cap-launch-b");
    const r = await p.exec(h, {
      command: launchScript("bt_bash22", "[[ 1 == 1 ]] && echo ok; echo {1..3}", 60),
      cwd: "/workspace",
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      signal: sig(),
      tag: "test",
      actor: ACTOR,
    });
    expect(r.exitCode).toBe(0);
    const dir = join(fakeWorkspaceDir(root, h.id), ".capybara", "tasks");
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
    const h = await instance(p, "cap-launch-x");
    const run = (c: string) =>
      p.exec(h, {
        command: c,
        cwd: "/workspace",
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
        signal: sig(),
        tag: "test",
        actor: ACTOR,
      });
    expect(
      (await run(launchScript("bt_fail22", "echo out; echo err >&2; exit 3", 60))).exitCode,
    ).toBe(0);
    expect((await run(launchScript("bt_slow22", "sleep 30", 1))).exitCode).toBe(0);
    const dir = join(fakeWorkspaceDir(root, h.id), ".capybara", "tasks");
    await until(() => existsSync(join(dir, "bt_fail22.exit")));
    expect(await readFile(join(dir, "bt_fail22.exit"), "utf8")).toBe("3\n");
    expect(await readFile(join(dir, "bt_fail22.out"), "utf8")).toBe("out\nerr\n");
    await until(() => existsSync(join(dir, "bt_slow22.exit")));
    expect(await readFile(join(dir, "bt_slow22.exit"), "utf8")).toBe("137\n");
  });
});

/**
 * The process group path (macOS: no setsid, no timeout, no `pgrep -s`), run with bash on the host
 * with a `pgrep` that refuses `-s` first on PATH, so it is checked on Linux CI too. The real macOS
 * OS sandbox runs it in packages/device/test/exec-os-background.test.ts.
 */
const hasPerl = spawnSync("perl", ["-MPOSIX", "-e", "1"]).status === 0;
describe.skipIf(!hasPerl)("the process group path", () => {
  let ws: string;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    ws = join(root, "group-ws");
    mkdirSync(ws, { recursive: true });
    const bin = join(root, "group-bin");
    mkdirSync(bin, { recursive: true });
    await writeFile(
      join(bin, "pgrep"),
      "#!/bin/sh\necho 'pgrep: illegal option -- s' >&2\nexit 2\n",
    );
    chmodSync(join(bin, "pgrep"), 0o755);
    env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  });
  const sh = (script: string) => {
    const r = spawnSync("bash", ["-c", script], {
      cwd: ws,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const file = (id: string, ext: string) =>
    readFile(join(ws, ".capybara", "tasks", `${id}.${ext}`), "utf8").catch(() => null);
  const alive = (sid: string) => sh(`${SESSION_MODE_SCRIPT}\ntk_alive ${sid}`).exitCode === 0;
  const launch = (id: string, command: string, seconds: number) => {
    const r = sh(launchScript(id, command, seconds));
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
    return r.stdout.trim();
  };

  it("selects -g", () => {
    expect(sh(`${SESSION_MODE_SCRIPT}\necho "$pg"`).stdout).toBe("-g\n");
  });

  it("outlives the launch; output and exit status in the task files; the group ends with it", async () => {
    const sid = launch("bt_grp222", "echo out; echo err >&2; sleep 300 & sleep 1; exit 3", 60);
    expect(alive(sid)).toBe(true);
    await until(() => existsSync(join(ws, ".capybara/tasks/bt_grp222.exit")));
    expect(await file("bt_grp222", "exit")).toBe("3\n");
    expect(await file("bt_grp222", "out")).toBe("out\nerr\n");
    // the sleep it left running is killed with it
    await until(() => !alive(sid));
  });

  it("the time limit SIGKILLs a tree that ignores SIGTERM: 137", async () => {
    const sid = launch("bt_grp333", `trap "" TERM; (trap "" TERM; sleep 300) & sleep 300`, 1);
    await until(() => existsSync(join(ws, ".capybara/tasks/bt_grp333.exit")));
    expect(await file("bt_grp333", "exit")).toBe("137\n");
    await until(() => !alive(sid));
  });

  it("a stop: SIGTERM through the launcher, then SIGKILL until the group is empty", async () => {
    const sid = launch("bt_grp444", "sleep 300 & sleep 300 & wait", 60);
    expect(sh(termScript("bt_grp444", sid)).stdout.trim()).toBe("term");
    expect(alive(sid)).toBe(false);
    // a stop writes no exit file
    expect(await file("bt_grp444", "exit")).toBeNull();

    const stubborn = launch("bt_grp555", `trap "" TERM; (trap "" TERM; sleep 300) & sleep 300`, 60);
    expect(sh(termScript("bt_grp555", stubborn)).stdout.trim()).toBe("term");
    expect(alive(stubborn)).toBe(true);
    expect(sh(`${killSessionScript(stubborn)}; exit "$ks"`).exitCode).toBe(0);
    expect(alive(stubborn)).toBe(false);
  });

  it("a launch without perl fails readably before anything starts", () => {
    const r = spawnSync("/bin/bash", ["-c", launchScript("bt_grp666", "true", 60)], {
      cwd: ws,
      env: { ...env, PATH: `${join(root, "group-bin")}:/nonexistent` },
      encoding: "utf8",
    });
    // bash itself is found by its absolute path here; command -v sees only the PATH
    expect(r.status).toBe(127);
    expect(r.stderr).toContain(
      "Background tasks need bash, perl, nohup, base64 in this environment;",
    );
  });
});
