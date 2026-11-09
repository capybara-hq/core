// Redaction of setup check results (spec 2026-11-09-setup-guides-v2-design.md §10.8): every known
// secret value of 8 characters or more is replaced by `[REDACTED]` in the reason and fix, as exact
// substrings with the longest match first (the logger's matcher). The caller validates the result
// before and after (redaction can push a text over its length limit, which makes it invalid).
import type { SetupCheckResult, SetupCheckText } from "@capybara-hq/plugin-sdk";
import { createRedactor } from "../log.js";

/** The shortest secret value redacted from a check result (shorter values would hit plain words). */
export const CHECK_SECRET_MIN_CHARS = 8;

/** A redactor over the given secret values (only strings of at least 8 characters count). */
export function checkRedactor(secrets: readonly unknown[]): (s: string) => string {
  return createRedactor(
    secrets.filter((v) => typeof v === "string"),
    CHECK_SECRET_MIN_CHARS,
  );
}

const redactText = (t: SetupCheckText, redact: (s: string) => string): SetupCheckText => ({
  en: redact(t.en),
  ...(t.zh !== undefined && { zh: redact(t.zh) }),
});

/**
 * A fresh plain object of a validated result with its texts redacted (validate it again: the
 * redacted copy may be too long now). Only `status`, `reason` and `fix` are carried over.
 */
export function redactCheckResult(
  result: SetupCheckResult,
  redact: (s: string) => string,
): SetupCheckResult {
  return {
    status: result.status,
    ...(result.reason !== undefined && { reason: redactText(result.reason, redact) }),
    ...(result.fix !== undefined && { fix: redactText(result.fix, redact) }),
  };
}

/** The most of an extension's error message that reaches a log line (after redaction). */
const ERROR_LOG_CHARS = 500;

/**
 * What a log line may say about an error a check threw: its name and its redacted, shortened
 * message, never the error object (a stack or a `cause` can carry what the message does not).
 */
export function describeCheckError(
  err: unknown,
  redact: (s: string) => string,
): { name: string; message: string } {
  let name = "Error";
  let message = "";
  try {
    if (err instanceof Error) {
      name = typeof err.name === "string" ? err.name.slice(0, 64) : "Error";
      message = typeof err.message === "string" ? err.message : "";
    } else {
      name = typeof err;
      message = typeof err === "string" ? err : "";
    }
  } catch {
    // a hostile error object (a throwing getter): nothing more to say about it
  }
  return { name: redact(name), message: redact(message).slice(0, ERROR_LOG_CHARS) };
}
