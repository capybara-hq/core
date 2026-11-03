import { listAuthSources } from "../auth-sources";
import { previewInvitation } from "../members";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The sign-in sources (third-party buttons) the login page offers. */
export const authSourcesQuery = () =>
  defineQuery({
    key: keys.deployment().authSources(),
    fn: () => listAuthSources().then((r) => r.sources),
    freshness: "deployment",
  });

/** An invitation's public preview (org, role, expiry); a used or expired token is refused. */
export const invitationQuery = (token: string) =>
  defineQuery({
    key: keys.deployment().invitation(token),
    fn: () => previewInvitation(token),
    freshness: "deployment",
  });
