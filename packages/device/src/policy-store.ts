import { statSync } from "node:fs";
import { type Policy, policyPath, readPolicyFile, withPolicyLock, writePolicy } from "./state.js";

/** What identifies one version of policy.json: absent, or its inode, size and mtime. */
function versionOf(file: string): string {
  try {
    const st = statSync(file);
    // An atomic write (rename) changes the inode; an in-place edit changes size or mtime.
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

/**
 * The device's local policy as the running program sees it. Commands read {@link current} at
 * each exec, so a change applies at the next command without a restart, whether this program
 * wrote it ({@link update}) or someone ran `capybara-device policy` meanwhile.
 */
export class PolicyStore {
  private policy: Policy;
  private version: string;
  private readonly file: string;
  private readonly err: (line: string) => void;

  constructor(
    private readonly dir: string,
    opts: { err?: (line: string) => void; initial?: Policy } = {},
  ) {
    this.file = policyPath(dir);
    this.err = opts.err ?? (() => {});
    this.version = versionOf(this.file);
    // Without an initial policy, an unreadable file throws here: the program does not start.
    this.policy = opts.initial ?? readPolicyFile(dir).policy;
  }

  /**
   * The policy now: re-reads policy.json when it changed (or appeared, or vanished: defaults).
   * An invalid file keeps the last good policy, never a looser one, and is reported once per
   * version.
   */
  current(): Policy {
    const version = versionOf(this.file);
    if (version === this.version) return this.policy;
    this.version = version;
    try {
      this.policy = readPolicyFile(this.dir).policy;
    } catch (e) {
      this.err(`${(e as Error).message}; keeping the last valid policy until the file is fixed`);
    }
    return this.policy;
  }

  /**
   * Read-modify-write under policy.json.lock: reads the file (throws on an invalid one rather
   * than overwrite it), writes the change atomically keeping unknown keys, and swaps the
   * in-memory policy. Returns the new policy.
   */
  update(change: (p: Policy) => Policy): Policy {
    return withPolicyLock(this.dir, () => {
      const { policy, extra } = readPolicyFile(this.dir);
      const next = change(policy);
      writePolicy(this.dir, next, extra);
      this.policy = next;
      this.version = versionOf(this.file);
      return next;
    });
  }
}
