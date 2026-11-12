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
 * wrote it ({@link update}) or someone ran `capybara-device policy` meanwhile. Each new version
 * is a new object, so a reader can tell a reload by identity (the OS executor reruns its
 * localhost proxy guard then).
 */
export class PolicyStore {
  private policy: Policy;
  private version: string;
  /** The broken version last reported, so each one is reported once. */
  private reportedBad: string | undefined;
  private readonly file: string;
  private readonly err: (line: string) => void;
  /**
   * policy.json had the legacy `network: "open"` when the store was made (start prints a notice;
   * the key is dropped at the next write).
   */
  readonly legacyNetworkOpen: boolean;

  constructor(
    private readonly dir: string,
    opts: { err?: (line: string) => void; initial?: Policy } = {},
  ) {
    this.file = policyPath(dir);
    this.err = opts.err ?? (() => {});
    this.version = versionOf(this.file);
    // Without an initial policy, an unreadable file throws here: the program does not start.
    if (opts.initial !== undefined) {
      this.policy = opts.initial;
      this.legacyNetworkOpen = false;
    } else {
      const read = readPolicyFile(dir);
      this.policy = read.policy;
      this.legacyNetworkOpen = read.legacyNetworkOpen;
    }
  }

  /**
   * The policy now: re-reads policy.json when it changed (or appeared, or vanished: defaults).
   * An invalid file keeps the last good policy, never a looser one, with the sandbox turned back
   * on (a broken file never keeps commands running unsandboxed), and is reported once per version.
   */
  current(): Policy {
    const version = versionOf(this.file);
    if (version === this.version) return this.policy;
    try {
      this.policy = readPolicyFile(this.dir).policy;
      // Advanced only on a good read: a broken version is retried until it is fixed.
      this.version = version;
      this.reportedBad = undefined;
    } catch (e) {
      // A new object only when it narrows: readers tell a reload by identity.
      if (this.policy.isolation === "none") this.policy = { ...this.policy, isolation: "sandbox" };
      if (this.reportedBad !== version) {
        this.reportedBad = version;
        this.err(
          `${(e as Error).message}; keeping the last valid policy with the sandbox on until the ` +
            "file is fixed",
        );
      }
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
