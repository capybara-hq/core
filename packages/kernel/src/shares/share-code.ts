import { randomBytes } from "node:crypto";

/**
 * Share codes (file sharing spec §1): 10 characters of `[A-Za-z0-9]` from a CSPRNG, about 59.5
 * bits, so links cannot be guessed or enumerated. Each character comes from one random byte by
 * rejection sampling: bytes at or above 248 (4 × 62) are skipped, so every character is equally
 * likely (a plain `byte % 62` would favour the first eight).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 10;
/** The largest multiple of 62 that fits a byte; bytes from here on are rejected. */
const REJECT_FROM = 256 - (256 % ALPHABET.length);

/** A share code as it appears in `/s/<code>`. */
export const SHARE_CODE_RE = /^[A-Za-z0-9]{10}$/;

/** A new random share code. `random` is the byte source (tests); `crypto.randomBytes` by default. */
export function newShareCode(random: (n: number) => Buffer = randomBytes): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    // a few spare bytes, so one batch almost always suffices
    for (const b of random(CODE_LENGTH + 4)) {
      if (b >= REJECT_FROM) continue;
      code += ALPHABET[b % ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}
