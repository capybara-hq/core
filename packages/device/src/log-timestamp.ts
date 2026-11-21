/**
 * Timestamps for the service log. The login service redirects stdout / stderr to `service.log`, so
 * without them a reader cannot tell an old failure from a current one. Only `start` uses them;
 * the interactive commands stay plain.
 */

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Local time as ISO-8601 with milliseconds and offset, e.g. `2026-11-21T12:56:30.913+08:00`. */
export function localTimestamp(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Prefixes every line of `text` with the timestamp (a multi-line message keeps each line dated). */
export function stampLines(text: string, now: () => Date = () => new Date()): string {
  const stamp = localTimestamp(now());
  return text
    .split("\n")
    .map((line) => `${stamp} ${line}`)
    .join("\n");
}

/** Wraps a line writer so every line it writes carries the timestamp. */
export function stamped(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): (line: string) => void {
  return (line) => write(stampLines(line, now));
}

/**
 * Logs an uncaught exception or unhandled rejection with a timestamp, stack included, and exits 1
 * as Node does, so the service manager restarts the program.
 */
export function installCrashLog(
  proc: Pick<NodeJS.Process, "on" | "exit" | "stderr"> = process,
  now: () => Date = () => new Date(),
): void {
  const crash = (label: string) => (reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason);
    try {
      proc.stderr.write(`${stampLines(`${label}: ${detail}`, now)}\n`);
    } finally {
      proc.exit(1);
    }
  };
  proc.on("uncaughtException", crash("Uncaught exception"));
  proc.on("unhandledRejection", crash("Unhandled rejection"));
}
