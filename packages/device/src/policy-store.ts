import { statSync } from "node:fs";
import {
  closedPolicy,
  type Policy,
  type PolicyFile,
  PolicyVersionError,
  policyPath,
  readPolicyFile,
  withPolicyLock,
  writePolicy,
} from "./state.js";

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

  constructor(
    private readonly dir: string,
    opts: { initial?: Policy } = {},
  ) {
    this.file = policyPath(dir);
    this.version = versionOf(this.file);
    // Without an initial policy, an unreadable file throws here: the program does not start.
    this.policy = opts.initial ?? readPolicyFile(dir).policy;
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
   * in-memory policy. Returns the new policy. `replaceOtherVersion` (only the owner's
   * `capybara-device ceiling set`): a file in another format version is replaced, the change
   * applied to the closed policy and nothing of the old file kept.
   */
  update(change: (p: Policy) => Policy, opts: { replaceOtherVersion?: boolean } = {}): Policy {
    return withPolicyLock(this.dir, () => {
      let read: PolicyFile;
      try {
        read = readPolicyFile(this.dir);
      } catch (e) {
        if (!(opts.replaceOtherVersion === true && e instanceof PolicyVersionError)) throw e;
        read = { policy: closedPolicy(), extra: {} };
      }
      const { policy, extra } = read;
      const next = change(policy);
      writePolicy(this.dir, next, extra);
      this.policy = next;
      this.version = versionOf(this.file);
      return next;
    });
  }
}
