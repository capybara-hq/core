import { apiFetch } from "./api";

/**
 * Native app sign-in as the consent page `/apps/authorize` uses it (the kernel's
 * `packages/kernel/src/identity/app-auth.controller.ts`; desktop client spec §6.5). Web code never
 * imports kernel code.
 */

/** The native apps that sign in through the consent page (mobile spec §4.3). */
export const APP_CLIENTS = ["desktop", "mobile"] as const;
export type AppClient = (typeof APP_CLIENTS)[number];

/** The query's `client` when it names a known app, else null. */
export function appClientOf(q: Readonly<Record<string, string | undefined>>): AppClient | null {
  const client = (q.client ?? "").trim();
  return (APP_CLIENTS as readonly string[]).includes(client) ? (client as AppClient) : null;
}

/** The body of `POST /api/v1/app-auth/authorize`. */
export interface AuthorizeAppBody {
  client: AppClient;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
  name: string;
  appVersion: string;
  deny?: boolean;
}

/**
 * What the web reads from `GET /api/v1/meta`: the platform's name and its uploaded icons' versioned
 * URLs (`/api/v1/platform/icon/<purpose>?v=<sha256>`; null = the web's default for that purpose).
 */
export interface PlatformMeta {
  name: string | null;
  icons: { app: string | null; maskable: string | null; favicon: string | null };
}

/** The request the app described in the page's query, or null when a parameter is missing or wrong. */
export function authorizeRequest(
  q: Readonly<Record<string, string | undefined>>,
): AuthorizeAppBody | null {
  const get = (k: string) => (q[k] ?? "").trim();
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  const state = get("state");
  const name = get("name");
  const appVersion = get("app_version");
  const client = appClientOf(q);
  if (client === null || get("code_challenge_method") !== "S256") return null;
  if (redirectUri === "" || codeChallenge === "" || state === "") return null;
  if (name === "" || appVersion === "") return null;
  return {
    client,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    state,
    name,
    appVersion,
  };
}

/** The kernel answers with the app redirect to navigate to (the code, or `access_denied`). */
export const authorizeApp = (body: AuthorizeAppBody) =>
  apiFetch<{ redirect: string }>("/api/v1/app-auth/authorize", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getPlatformMeta = () => apiFetch<PlatformMeta>("/api/v1/meta");
