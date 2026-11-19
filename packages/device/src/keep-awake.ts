import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { KeepAwakeMode } from "./state.js";

/** The assertion holders (decision 4): macOS ties it to the runner's pid, Linux to `sleep`. */
export function holderCommand(
  platform: NodeJS.Platform,
  pid: number,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin")
    return { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--mode=block",
        "--who=capybara-device",
        "--why=Capybara device is serving",
        "sleep",
        "infinity",
      ],
    };
  }
  return undefined;
}

export interface KeepAwakeOptions {
  platform: NodeJS.Platform;
  /** The runner's pid (macOS `caffeinate -w` ends the assertion when it exits). */
  pid: number;
  spawn?: typeof nodeSpawn;
}

type Holder = Pick<ChildProcess, "kill" | "on">;

/**
 * Holds an OS idle-sleep assertion through a child process while the mode asks for it: the whole
 * time connected (`connected`), or while operations run (`while-busy`). A holder that cannot start
 * or ends early is reported as `unavailable` with the reason; nothing pretends it is held.
 */
export class KeepAwake {
  private readonly spawnFn: typeof nodeSpawn;
  private holder: Holder | undefined;
  private unavailable: string | undefined;
  private mode: KeepAwakeMode = "off";

  constructor(private readonly o: KeepAwakeOptions) {
    this.spawnFn = o.spawn ?? nodeSpawn;
  }

  update(i: { mode: KeepAwakeMode; connected: boolean; busy: boolean }): void {
    this.mode = i.mode;
    const want = (i.mode === "connected" && i.connected) || (i.mode === "while-busy" && i.busy);
    if (!want) {
      this.release();
      // a failure is about an attempt; once nothing is wanted there is nothing to report
      this.unavailable = undefined;
      return;
    }
    if (this.holder !== undefined) return;
    this.acquire();
  }

  state(): { mode: KeepAwakeMode; held: boolean; unavailable?: string } {
    return {
      mode: this.mode,
      held: this.holder !== undefined,
      ...(this.unavailable !== undefined && { unavailable: this.unavailable }),
    };
  }

  dispose(): void {
    this.release();
  }

  private acquire(): void {
    const cmd = holderCommand(this.o.platform, this.o.pid);
    if (cmd === undefined) {
      this.unavailable = `keep-awake is not supported on ${this.o.platform}`;
      return;
    }
    let child: Holder;
    try {
      child = this.spawnFn(cmd.command, cmd.args, { stdio: "ignore" });
    } catch (e) {
      this.unavailable = `cannot start ${cmd.command}: ${(e as Error).message}`;
      return;
    }
    this.unavailable = undefined;
    this.holder = child;
    const gone = (why: string): void => {
      // only this holder: a newer one is not affected by an old one's late event
      if (this.holder !== child) return;
      this.holder = undefined;
      this.unavailable = why;
    };
    child.on("error", (e: Error) => gone(`cannot run ${cmd.command}: ${e.message}`));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      gone(`${cmd.command} ended (${signal ?? `exit ${code}`})`),
    );
  }

  private release(): void {
    const h = this.holder;
    this.holder = undefined;
    if (h === undefined) return;
    try {
      h.kill();
    } catch {
      // already gone
    }
  }
}
