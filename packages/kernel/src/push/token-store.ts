import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type Keyring, pushTokenAad } from "../ctx/secrets.js";
import { KEYRING } from "../infra/tokens.js";

/** A push token sealed for one registration, as `push_registrations` stores it. */
export interface SealedPushToken {
  masterKeyId: string;
  ciphertext: Buffer;
  /** sha256 hex of the token: the uniqueness key, never the token itself. */
  tokenHash: string;
}

/**
 * Seals and opens a device's push token (mobile app spec §9.3) with the master keyring, bound to
 * its registration id: a ciphertext moved to another row fails to open. The token never leaves
 * this store except to the push provider that delivers to it: never a log line, an error message,
 * the audit, job data or an API answer.
 */
@Injectable()
export class PushTokenStore {
  constructor(@Inject(KEYRING) private readonly keyring: Keyring) {}

  /** The sha256 hex of a token (64 characters), the column that keeps registrations unique. */
  static hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** Seals `token` for the registration with the current master key. */
  seal(registrationId: string, token: string): SealedPushToken {
    const plain = Buffer.from(token, "utf8");
    const { data, masterKeyId } = this.keyring.wrap(plain, pushTokenAad(registrationId));
    plain.fill(0);
    return { masterKeyId, ciphertext: data, tokenHash: PushTokenStore.hash(token) };
  }

  /**
   * Opens a registration's token. Throws when the master key is not in the keyring or the
   * ciphertext does not belong to this registration; the error names ids only.
   */
  open(row: { id: string; master_key_id: string; token_ciphertext: Uint8Array }): string {
    const plain = this.keyring.unwrap(
      row.master_key_id,
      Buffer.from(row.token_ciphertext),
      pushTokenAad(row.id),
    );
    const token = plain.toString("utf8");
    plain.fill(0);
    return token;
  }
}
