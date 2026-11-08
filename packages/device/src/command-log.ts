import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const COMMAND_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface CommandLogEntry {
  time: string;
  op: string;
  tag: string | null;
  actor: { accountId: string } | null;
  exitCode: number | null;
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
