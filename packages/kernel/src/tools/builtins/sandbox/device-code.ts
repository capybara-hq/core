/**
 * `gh auth login --web`'s device-code prompt (auto mode spec §6, P-D13). A cloud device's `gh`
 * login prints a fixed pair: the one-time code and the device-login URL. The kernel recognises
 * exactly that text and hands it to the web card; the token the login finally writes stays in the
 * device's container and never reaches the kernel.
 *
 * Pure: it reads an exec result's output and has no side effects. Only `gh`'s own wording matches
 * on purpose — another CLI's device flow is not recognised (P-D13); a parser for it can be added
 * the same way later. Recognition is output-only, so a command that prints the same text by hand
 * produces the same card; the card only opens GitHub's fixed URL and shows the printed code.
 *
 * When the card appears: the kernel parses the output it is handed, so a `Bash` call's result when
 * the command returns, or a `TaskOutput` read of a background task's output while the command is
 * still waiting. There is no streaming stage: a foreground `gh auth login --web` returns only when
 * the flow ends (the code is then spent), so the login belongs in the background, read with
 * `TaskOutput`.
 */

/** The one URL `gh auth login --web` sends the person to. */
export const GITHUB_DEVICE_LOGIN_URL = "https://github.com/login/device";

/** The one-time code `gh` prints (`XXXX-XXXX`, upper-case letters and digits). */
export const DEVICE_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** What the pipeline shows the person: the URL to open and the code to enter. */
export interface DeviceCode {
  url: string;
  code: string;
}

/**
 * The line `gh` prints first: `! First copy your one-time code: 1A2B-C3D4`. Anchored to the line's
 * start and its full text so a similar sentence inside another program's output does not match.
 * Global only so {@link parseDeviceCode} can walk every prompt it finds; it is never used with
 * `exec`, so no `lastIndex` state is kept between calls.
 */
const CODE_LINE = /^!\s*First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/gm;

/**
 * The GitHub device-login URL as its own token: exactly the URL, followed by whitespace or the end
 * of the output (the recorded `gh` line has a space after it). A query, a fragment, a path or a
 * lookalike host does not match.
 */
const URL_TOKEN = /https:\/\/github\.com\/login\/device(?=\s|$)/;

/** The idempotency key of a call's `device_code` event (a retry or a resumed run writes it once). */
export const deviceCodeIdemKey = (runId: string, callId: string): string =>
  `device_code:${runId}:${callId}`;

/**
 * The device code in an exec result's output, or `null` when the text is not `gh auth login --web`'s
 * fixed prompt. Both halves must be there: the `! First copy your one-time code:` line with a
 * well-formed code, and the GitHub device-login URL.
 *
 * When the text holds more than one prompt, the **last** code line wins. `TaskOutput` parses a
 * window that re-reads up to 4 KiB of already-delivered output before the new bytes, so a retried
 * login can put the old prompt (and its spent code) ahead of the live one; the newest prompt is
 * always the later bytes, and returning it keeps the new card from being swallowed by the per-code
 * dedupe. With one prompt the rule is unchanged.
 */
export function parseDeviceCode(output: string): DeviceCode | null {
  let code: string | undefined;
  for (const match of output.matchAll(CODE_LINE)) code = match[1];
  if (code === undefined || !DEVICE_CODE_PATTERN.test(code)) return null;
  if (!URL_TOKEN.test(output)) return null;
  return { url: GITHUB_DEVICE_LOGIN_URL, code };
}
