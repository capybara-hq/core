import { statSync } from "node:fs";
import { PolicyOpLog } from "./policy-ops.js";
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
 * The device's local policy as the running program sees it. {@link current} re-reads policy.json
 * whenever it changed, so a change applies without a restart, whether this program wrote it
 * ({@link update}) or someone ran `capybara-device ceiling` / `capybara-device policy` meanwhile.
 * A file that cannot be read is no authority: {@link current} throws until it is fixed, and never
 * falls back to a policy read earlier. Each new version is a new object.
 */
export class PolicyStore {
  private policy: Policy;
  private version: string;
  private readonly file: string;
  /**
   * policy.json was written before auto mode (no `mode`) when the store was made: `start` prints
   * one notice, and the key is dropped at the next write.
   */
  readonly legacy: boolean;
  /** The outcomes of the `policy` ops this machine served, by op id (next to policy.json). */
  readonly ops: PolicyOpLog;

  constructor(
    private readonly dir: string,
    opts: { initial?: Policy } = {},
  ) {
    this.file = policyPath(dir);
    this.ops = new PolicyOpLog(dir);
    this.version = versionOf(this.file);
    // Without an initial policy, an unreadable file throws here: the program does not start.
    if (opts.initial !== undefined) {
      this.policy = opts.initial;
      this.legacy = false;
    } else {
      const read = readPolicyFile(dir);
      this.policy = read.policy;
      this.legacy = read.legacy;
    }
  }

  /**
   * The policy now: re-reads policy.json when it changed (or appeared, or vanished: the closed
   * `MISSING_POLICY_OWNER_CEILING`, never the open default).
   * An invalid file throws (with the reason) at every call until it is fixed.
   */
  current(): Policy {
    const version = versionOf(this.file);
    if (version === this.version) return this.policy;
    this.policy = readPolicyFile(this.dir).policy;
    // advanced only on a good read: a broken version is read again until it is fixed
    this.version = version;
    return this.policy;
  }

  /**
   * Read-modify-write under policy.json.lock: reads the file (throws on an invalid one rather
   * than overwrite it), writes the change atomically keeping unknown keys, and swaps the
   * in-memory policy. `written` runs after that, still holding the lock (the `policy` op logs its
   * outcome there, next to the change). Returns the new policy.
   */
  update(change: (p: Policy) => Policy, opts: { written?: (p: Policy) => void } = {}): Policy {
    return withPolicyLock(this.dir, () => {
      const { policy, extra } = readPolicyFile(this.dir);
      const next = change(policy);
      writePolicy(this.dir, next, extra);
      this.policy = next;
      this.version = versionOf(this.file);
      opts.written?.(next);
      return next;
    });
  }
}
