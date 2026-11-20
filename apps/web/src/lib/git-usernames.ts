/**
 * The Basic auth username a git host documents for a token, to pre-fill a marketplace's username
 * field. A local copy of `suggestGitUsername` in `packages/plugin-sdk/src/git-hosts.ts` (the web app
 * never imports the SDK); `test/git-usernames.test.ts` pins the two together. An empty result means
 * no suggestion: the admin enters what the host's documentation names.
 */
export function suggestGitUsernameForHost(host: string): string | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".ghe.com")) return "x-access-token";
  if (h === "bitbucket.org") return "x-token-auth";
  if (h === "gitlab.com") return "oauth2";
  return undefined;
}

/** The host of a git marketplace address: an https URL or `git@host:path` (`owner/repo` names no host: the default username applies). */
function hostOf(address: string): string | undefined {
  const a = address.trim();
  if (a === "") return undefined;
  if (/^https?:\/\//i.test(a)) {
    try {
      return new URL(a).hostname;
    } catch {
      return undefined;
    }
  }
  const scp = /^[\w.-]+@([\w.-]+):/.exec(a);
  if (scp) return scp[1];
  return undefined;
}

/** The suggested username for a git marketplace address (see {@link suggestGitUsernameForHost}). */
export function suggestGitUsernameForUrl(address: string): string | undefined {
  const host = hostOf(address);
  return host === undefined ? undefined : suggestGitUsernameForHost(host);
}
