// The third-party sign-in routes' paths: a leaf module (no service imports), so the SSO flow and
// `{{signInCallbackUrl}}` of the setup guides build the callback from one place. The controller's
// decorators stay string literals (check:platform-ops matches routes by them);
// test/identity/sso-paths.test.ts keeps them and these constants equal.

/** The prefix of the SSO routes (`SsoController`); also the browser binding cookie's Path. */
export const SSO_PATH_PREFIX = "/api/v1/auth/sso";

/**
 * The path of a sign-in source's callback route (`GET /api/v1/auth/sso/:plugin/callback`):
 * `http.publicUrl` + this is the redirect URI registered at the identity provider.
 */
export function ssoCallbackPath(plugin: string): string {
  return `${SSO_PATH_PREFIX}/${encodeURIComponent(plugin)}/callback`;
}
