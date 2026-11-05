import { listAuthSources } from "../auth-sources";
import { peekBinding } from "../identities";
import { previewInvitation } from "../members";
import { getSetupStatus } from "../session";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The sign-in sources (third-party buttons) the login page offers. */
export const authSourcesQuery = () =>
  defineQuery({
    key: keys.deployment().authSources(),
    fn: () => listAuthSources().then((r) => r.sources),
    freshness: "deployment",
  });

/**
 * Whether the deployment still needs its first admin. The setup layout asks on the server; the
 * browser reads this only when the kernel did not answer it there (starting, unreachable).
 */
export const setupStatusQuery = () =>
  defineQuery({
    key: keys.deployment().setupStatus(),
    fn: () => getSetupStatus().then((r) => r.needsSetup),
    freshness: "deployment",
  });

/** An invitation's public preview (org, role, expiry); a used or expired token is refused. */
export const invitationQuery = (token: string) =>
  defineQuery({
    key: keys.deployment().invitation(token),
    fn: () => previewInvitation(token),
    freshness: "deployment",
  });

/** The IM identity a binding link would bind to the signed-in account (a 401 when signed out). */
export const pendingBindingQuery = (token: string) =>
  defineQuery({
    key: keys.deployment().pendingBinding(token),
    fn: () => peekBinding(token).then((r) => r.binding),
    freshness: "deployment",
  });
