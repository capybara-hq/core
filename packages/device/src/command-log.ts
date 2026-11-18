import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export const COMMAND_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface CommandLogEntry {
  time: string;
  op: string;
  tag: string | null;
  /** Who asked: the account, and for an operation the conversation it ran for. */
  actor: { accountId: string; conversationId?: string } | null;
  exitCode: number | null;
  /** How an operation ran: restricted (the permission sandbox) or full (Full access). */
  isolation?: "restricted" | "full";
  /**
   * An audit line: a policy change from the deployment (`policy add a.com by <name> (<id>) via
   * web, approval <id>`) or the machine (`policy add allowedDomains a.com by <user> via cli`), the
   * grants an exec was given (`grants run <id> by <id>: a.com`) or a failure's kind.
   */
  detail?: string;
}

/** One JSON line per operation in `<stateDir>/commands.log`; rotated to `commands.log.1` at 10 MiB. */
export class CommandLog {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly maxBytes: number = COMMAND_LOG_MAX_BYTES,
  ) {
    this.file = join(stateDir, "commands.log");
  }

  append(entry: CommandLogEntry): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.file).size >= this.maxBytes) renameSync(this.file, `${this.file}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // The local log never fails an operation.
    }
  }
}

/** The local user who ran a CLI command, for the audit line (empty when unknown). */
function localUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/** Records a policy change made on the machine with the CLI: best effort, never fails it. */
export function noteCliPolicyChange(stateDir: string, what: string): void {
  const user = localUser();
  try {
    new CommandLog(stateDir).append({
      time: new Date().toISOString(),
      op: "policy",
      tag: null,
      actor: null,
      exitCode: null,
      detail: `${what}${user === "" ? "" : ` by ${user}`} via cli`,
    });
  } catch {
    // the local log never fails a change
  }
}
