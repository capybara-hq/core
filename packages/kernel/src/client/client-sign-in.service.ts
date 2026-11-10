import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Keyring } from "../ctx/secrets.js";
import type { UserPrincipal } from "../identity/principal.js";
import { KEYRING } from "../infra/tokens.js";

/** The HKDF purpose of the sign-in id key (`capybara:client-sign-in/v1`). */
const SIGN_IN_KEY_INFO = "client-sign-in/v1";

/** A sign-in id is 128 bits of the HMAC, base64url (22 characters). */
const SIGN_IN_ID_BYTES = 16;

/**
 * The sign-in ids of the shell reads (client extensions spec §4.2, `ClientApi.signIn`): an opaque
 * id per plugin that stays the same for one sign-in (one web session, across token refreshes and
 * every tab of it) and changes on the next sign-in, so client code can do something once per
 * sign-in. It is `HMAC-SHA256(key, "<sign-in>\0<plugin>")` truncated to 128 bits, the key derived
 * from the master keyring: not a credential and not reversible to the session id. The plugin name
 * is an input only so that the id is not the same string in every plugin; that is no isolation
 * boundary: client code runs with full trust in the page (spec D2) and can read the whole shell
 * read (or the query cache), which lists every plugin's id. Derived per request from the
 * principal, no state. A personal token (no session) is its own sign-in. Rotating the master key
 * changes every id once (client code then treats the session as a new sign-in); during a rolling
 * restart old and new replicas answer different ids, so it may look like more than one.
 */
@Injectable()
export class ClientSignIn {
  private readonly key: Buffer;

  constructor(@Inject(KEYRING) keyring: Keyring) {
    this.key = keyring.deriveKey(SIGN_IN_KEY_INFO).current;
  }

  /** The id function of the caller's sign-in: plugin name → that plugin's sign-in id. */
  of(principal: UserPrincipal): (plugin: string) => string {
    const signIn =
      principal.via === "session" ? `session:${principal.sessionId}` : `pat:${principal.tokenId}`;
    return (plugin) =>
      createHmac("sha256", this.key)
        .update(`${signIn}\0${plugin}`)
        .digest()
        .subarray(0, SIGN_IN_ID_BYTES)
        .toString("base64url");
  }
}
