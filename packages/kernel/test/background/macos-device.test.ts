import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecArgs, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// The real OS executor of capybara-device (macOS Seatbelt), the provider these scripts run on for a
// local macOS device. Source only: the device package depends on nothing of the kernel.
import {
  createOsExecutor,
  type OsExecutor,
  sandboxAvailability,
} from "../../../device/src/exec/os.js";
import { DEFAULT_POLICY } from "../../../device/src/state.js";
import { launchScript, SESSION_MODE_SCRIPT } from "../../src/background/launch.js";
import { killSessionScript, termScript } from "../../src/background/session.js";

const LIMITS: SandboxLimits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  egress: "none",
  allowHosts: [],
  tier: "strict",
  devHosts: [],
};

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond` holds (the old polling loop's 10 s budget); an error surfaces. */
const waitFor = (cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<unknown> =>
  vi.waitFor(
    async () => {
      if (!(await cond())) throw new Error("condition not met yet");
    },
    { timeout: ms },
  );

const availability = sandboxAvailability();

// The kernel's background task scripts (spec 2026-11-05-background-bash-design §4.2), run by the
// real OS executor: a macOS device has no setsid, no GNU timeout and no `pgrep -s`, and its sandbox
// lets no command list or signal another command's processes.

describe.skipIf(!availability.ok || process.platform !== "darwin")(
  "background tasks on a macOS OS-sandboxed device",
  () => {
    let base: string;
    let ex: OsExecutor;
    const never = new AbortController().signal;
    const DEV: SandboxLimits = { ...LIMITS, tier: "dev", defaultTier: "dev" };

    beforeAll(async () => {
      base = tmp("device-bg-");
      mkdirSync(join(base, "env"));
      mkdirSync(join(base, "s"));
      ex = await createOsExecutor({
        dir: join(base, "env"),
        policy: () => DEFAULT_POLICY,
        socketBase: join(base, "s"),
        detectProxy: async () => ({ detected: false, reasons: [] }),
      });
      await ex.ensureRoot();
    });
    afterAll(async () => {
      await ex?.dispose();
      if (base) rmSync(base, { recursive: true, force: true });
    });

    const run = (command: string, over: Partial<DeviceExecArgs> = {}) =>
      ex.exec(
        {
          command,
          cwd: ex.roots.workspace,
          timeoutMs: 20_000,
          maxOutputBytes: 64 * 1024,
          tag: "bg",
          actor: { accountId: "acc", conversationId: "conv" },
          limits: LIMITS,
          ...over,
        },
        never,
      );
    const task = (id: string, ext: string) =>
      join(ex.roots.workspace, ".capybara", "tasks", `${id}.${ext}`);
    const fileOf = (id: string, ext: string): string | null => {
      try {
        return readFileSync(task(id, ext), "utf8");
      } catch {
        return null;
      }
    };
    /** Whether the task still has a process, asked inside the sandbox as the poll asks. */
    const alive = async (sid: string): Promise<boolean> =>
      (await run(`${SESSION_MODE_SCRIPT}\ntk_alive ${sid}`)).exitCode === 0;
    const launch = async (
      id: string,
      command: string,
      seconds: number,
      limits: SandboxLimits = LIMITS,
    ) => {
      const r = await run(launchScript(id, command, seconds), { limits });
      expect(r).toMatchObject({ exitCode: 0, stderr: "" });
      expect(r.stdout).toMatch(/^[1-9][0-9]*\n$/);
      return r.stdout.trim();
    };

    it("selects the process group (-g) on macOS", async () => {
      expect((await run(`${SESSION_MODE_SCRIPT}\necho "$pg"`)).stdout).toBe("-g\n");
    });

    it("starts, outlives the launch exec, and leaves its output and exit status", async () => {
      const t0 = Date.now();
      const sid = await launch("bt_mac222", "echo out; echo err >&2; sleep 2; exit 3", 60);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(fileOf("bt_mac222", "sid")).toBe(`${sid}\n`);
      // the launch exec is over and the task still runs
      expect(await alive(sid)).toBe(true);
      expect(fileOf("bt_mac222", "exit")).toBeNull();
      await waitFor(() => fileOf("bt_mac222", "exit") !== null);
      expect(fileOf("bt_mac222", "exit")).toBe("3\n");
      expect(fileOf("bt_mac222", "out")).toBe("out\nerr\n");
      await waitFor(async () => !(await alive(sid)));
    });

    it("the task ends with its command: what it left running is killed", async () => {
      const sid = await launch("bt_macabc", "sleep 300 > /dev/null 2>&1 & echo left", 60);
      await waitFor(() => fileOf("bt_macabc", "exit") !== null);
      expect(fileOf("bt_macabc", "exit")).toBe("0\n");
      await waitFor(async () => !(await alive(sid)));
    });

    it("a foreground call's `sleep 300 &` is gone when it returns; a background task survives and stops", async () => {
      const sid = await launch("bt_macdef", "sleep 300", 60);
      const fg = await run("sleep 300 > /dev/null 2>&1 & echo $!");
      expect(fg.exitCode).toBe(0);
      const pid = Number(fg.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      // the device reaped the foreground call's leftover (SIGKILL, then launchd reaps the orphan)
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 3000);
      // the background task was launched by an exec too, and outlived it and the later call
      await sleep(1500);
      expect(await alive(sid)).toBe(true);
      expect(fileOf("bt_macdef", "exit")).toBeNull();
      const term = await run(termScript("bt_macdef", sid));
      expect(term.stdout.trim()).toBe("term");
      await waitFor(async () => !(await alive(sid)));
    });

    it("runs the command with bash and keeps it byte for byte", async () => {
      const command = `[[ 1 == 1 ]] && echo ok; echo {1..3}; echo 'q "d" $HOME \`x\`'`;
      await launch("bt_mac333", command, 60);
      await waitFor(() => fileOf("bt_mac333", "exit") !== null);
      expect(fileOf("bt_mac333", "sh")).toBe(command);
      expect(fileOf("bt_mac333", "out")).toBe('ok\n1 2 3\nq "d" $HOME `x`\n');
      expect(fileOf("bt_mac333", "exit")).toBe("0\n");
    });

    it("works at tier dev too", async () => {
      const sid = await launch("bt_mac444", "echo dev", 60, DEV);
      await waitFor(() => fileOf("bt_mac444", "exit") !== null);
      expect(fileOf("bt_mac444", "out")).toBe("dev\n");
      await waitFor(async () => !(await alive(sid)));
    });

    it("the time limit SIGKILLs the whole tree, a child that ignores SIGTERM too: exit 137", async () => {
      const sid = await launch(
        "bt_mac555",
        `trap "" TERM; (trap "" TERM; sleep 300) & echo started; sleep 300`,
        2,
      );
      await waitFor(() => fileOf("bt_mac555", "out") === "started\n");
      await waitFor(() => fileOf("bt_mac555", "exit") !== null, 15_000);
      expect(fileOf("bt_mac555", "exit")).toBe("137\n");
      await waitFor(async () => !(await alive(sid)));
    });

    it("a stop (SIGTERM, then SIGKILL of the group) kills the whole tree", async () => {
      const sid = await launch("bt_mac666", "sleep 300 & sleep 300 & wait", 60);
      const term = await run(termScript("bt_mac666", sid));
      expect(term.stdout.trim()).toBe("term");
      expect(await alive(sid)).toBe(false);

      // a tree that ignores SIGTERM survives the term and dies with the SIGKILL of the group
      const stubborn = await launch(
        "bt_mac777",
        `trap "" TERM; (trap "" TERM; sleep 300) & sleep 300`,
        60,
      );
      expect((await run(termScript("bt_mac777", stubborn))).stdout.trim()).toBe("term");
      expect(await alive(stubborn)).toBe(true);
      const kill = await run(`${killSessionScript(stubborn)}; exit "$ks"`);
      expect(kill.exitCode).toBe(0);
      expect(await alive(stubborn)).toBe(false);
    });
  },
);
