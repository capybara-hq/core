import { z } from "zod";
import { ApiError } from "../errors.js";

// The URL schemes of the native shells a browser handoff may send the person back to: pure, no
// Nest (shell external authorization spec §1, §3).

/** A plain URL scheme (RFC 3986 letters, lowercase only so the match stays exact). */
export const APP_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;
/** The app sign-in redirect URI a shell registers under its scheme (desktop client spec §6.5). */
const APP_CALLBACK_SUFFIX = "://auth/callback";

/** The config a scheme decision reads (`KernelConfig` fits). */
export type AppSchemesConfig = {
  http: { publicUrl?: string | undefined };
  auth: { appRedirectUris: readonly string[] };
};

/**
 * The schemes `s` for which an entry of `auth.appRedirectUris` is exactly `${s}://auth/callback`,
 * in list order; `[]` without `http.publicUrl` (no app sign-in, so no shell to return to).
 */
export function appSchemes(config: AppSchemesConfig): string[] {
  if (!config.http.publicUrl) return [];
  const out: string[] = [];
  for (const uri of config.auth.appRedirectUris) {
    if (!uri.endsWith(APP_CALLBACK_SUFFIX)) continue;
    const scheme = uri.slice(0, -APP_CALLBACK_SUFFIX.length);
    if (APP_SCHEME_RE.test(scheme) && !out.includes(scheme)) out.push(scheme);
  }
  return out;
}

/** A handoff start's return scheme: none passes; otherwise it must be one of {@link appSchemes}. */
export function assertReturnSchemeAllowed(
  config: AppSchemesConfig,
  scheme: string | undefined,
): void {
  if (scheme === undefined) return;
  if (!appSchemes(config).includes(scheme)) {
    throw new ApiError(
      "handoff.scheme_not_allowed",
      "This platform does not allow this app to finish authorizations in the browser (its <scheme>://auth/callback is not in auth.appRedirectUris)",
    );
  }
}

/**
 * The `handoff` field of the connector connect and the login-method link start: present when a
 * native shell asks to finish the flow in the system browser. `returnScheme` is the shell's own
 * URL scheme (for the done page's way back into the app).
 */
export const HandoffRequestSchema = z
  .object({ returnScheme: z.string().min(1).max(64).optional() })
  .strict();
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;
