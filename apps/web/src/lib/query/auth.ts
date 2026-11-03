import { listAuthSources } from "../auth-sources";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The sign-in sources (third-party buttons) the login page offers. */
export const authSourcesQuery = () =>
  defineQuery({
    key: keys.deployment().authSources(),
    fn: () => listAuthSources().then((r) => r.sources),
    freshness: "deployment",
  });
