/**
 * `gh auth login --web`'s device-code prompt (auto mode spec §6, P-D13). A cloud device's `gh`
 * login prints a fixed pair: the one-time code and the device-login URL. The kernel recognises
 * exactly that text and hands it to the web card; the token the login finally writes stays in the
 * device's container and never reaches the kernel.
 *
 * Pure: it reads an exec result's output and has no side effects. Only `gh`'s own wording matches
 * on purpose — another CLI's device flow is not recognised (P-D13); a parser for it can be added
 * the same way later.
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
 */
const CODE_LINE = /^!\s*First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m;

/** The GitHub device-login URL as its own token (not a prefix of a longer URL or path). */
const URL_TOKEN = /https:\/\/github\.com\/login\/device(?![\w./-])/;

/** The idempotency key of a call's `device_code` event (a retry or a resumed run writes it once). */
export const deviceCodeIdemKey = (runId: string, callId: string): string =>
  `device_code:${runId}:${callId}`;

/**
 * The device code in an exec result's output, or `null` when the text is not `gh auth login --web`'s
 * fixed prompt. Both halves must be there: the `! First copy your one-time code:` line with a
 * well-formed code, and the GitHub device-login URL.
 */
export function parseDeviceCode(output: string): DeviceCode | null {
  const code = CODE_LINE.exec(output)?.[1];
  if (code === undefined || !DEVICE_CODE_PATTERN.test(code)) return null;
  if (!URL_TOKEN.test(output)) return null;
  return { url: GITHUB_DEVICE_LOGIN_URL, code };
}
