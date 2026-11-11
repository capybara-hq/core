/**
 * Host checks the web runs before sending (the kernel checks again with the SDK's
 * `validateAllowHost`; network ask-to-allow spec §6.4): lowercase, no scheme, port or path, at
 * least two labels, no IP literal, no internal-only domain; a leading `*.` only where wildcards are
 * allowed (a device's local allowlist), never in a request or a task grant (exact hosts).
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `h` is not a valid allowlist host, or null when it is. */
export function allowHostProblem(
  h: string,
  { wildcard }: { wildcard: boolean },
): "invalid" | "wildcard" | null {
  if (h.length === 0 || h.length > 253) return "invalid";
  if (h.startsWith("*.") && !wildcard) return "wildcard";
  const name = h.startsWith("*.") ? h.slice(2) : h;
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return "invalid";
  const tld = labels[labels.length - 1] as string;
  if (!/^[a-z]/.test(tld)) return "invalid";
  if (["local", "internal", "localhost"].includes(tld)) return "invalid";
  return null;
}

/** A typed host as it is sent: trimmed and lowercased. */
export const normalizeHost = (h: string): string => h.trim().toLowerCase();

/** The prefix of a scheduled task's network grant key (`network:<host>`). */
export const NETWORK_GRANT_PREFIX = "network:";

/** The host of a network grant key, or null for a tool key. */
export const networkGrantHost = (key: string): string | null =>
  key.startsWith(NETWORK_GRANT_PREFIX) ? key.slice(NETWORK_GRANT_PREFIX.length) : null;
