// The token endpoint probe of `capybara:oauth-token-endpoint` (spec
// 2026-11-09-setup-guides-v2-design.md §10.6, decision 3 of §18): one authorization-code exchange
// with the stored client and a fixed, invalid code, read with the OAuth flow's refusal parser. The
// client secret stays in the kernel: it goes only into the request's Authorization header or form,
// only to the token endpoint the connect flow uses (the stored client record's), through
// `packages/kernel/src/net` (no redirects, the deployment's network rules) with the run's signal.
// Nothing is logged and nothing is written; a 2xx token body is never parsed for its token.
import type { SetupCheckResult, SetupCheckText } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { NetPolicy } from "../net/public-address.js";
import { NetDeniedError } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import {
  type OAuthClientRecord,
  parseTokenRefusal,
  tokenRequestInit,
} from "../tools/oauth/tokens.js";

/** The authorization code the probe sends: never a code any server issued. */
export const PROBE_CODE = "capybara-setup-probe";
/** A fixed PKCE verifier (43 characters, RFC 7636), so a server that demands one reads the code. */
const PROBE_VERIFIER = "capybara-setup-probe-verifier-0000000000000";
/** The most of a token endpoint answer the probe reads (an error body is a few hundred bytes). */
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * Codes that say the client authenticated and only the code was bad, as intended (RFC 6749,
 * Slack's `invalid_code`, GitHub's `bad_verification_code`).
 */
const ACCEPTED = new Set(["invalid_grant", "invalid_code", "bad_verification_code"]);
/** Codes that say the client id or secret is wrong (RFC 6749, Slack's and GitHub's). */
const CLIENT_REFUSED = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_client_id",
  "bad_client_secret",
  "incorrect_client_credentials",
]);
/** Codes that say the redirect URI is not registered (RFC 6749 servers and Slack's). */
const REDIRECT_REFUSED = new Set(["redirect_uri_mismatch", "bad_redirect_uri"]);

const text = (en: string, zh: string): SetupCheckText => ({ en, zh });

/** The probe's fixed texts: nothing a token endpoint sends ever reaches a result. */
export const PROBE_TEXTS = {
  accepted: text("The token endpoint accepted the client.", "令牌端点接受了这个客户端。"),
  clientRefused: text(
    "The token endpoint refused the client id or secret.",
    "令牌端点拒绝了客户端 ID 或密钥。",
  ),
  clientFix: text(
    "Copy the client ID and client secret again from the app's settings page.",
    "从应用的设置页面重新复制 Client ID 和 Client Secret。",
  ),
  redirectRefused: text(
    "The app does not list the callback URL.",
    "应用的重定向地址里没有这个回调地址。",
  ),
  unknown: text("Could not verify the client; retry later.", "无法验证这个客户端，请稍后重试。"),
  netDenied: text(
    "The token endpoint's address is refused by this deployment's network rules; ask your super admin.",
    "这个部署的网络规则拒绝访问令牌端点的地址，请联系超级管理员。",
  ),
} as const;

/**
 * The fix of a redirect refusal: the kernel-built callback URL (never anything the endpoint
 * said): `http.publicUrl` + the fixed callback path. (A public URL so long that the fix passes
 * its limit makes the result invalid, which the kernel answers as unknown.)
 */
export const redirectFix = (callbackUrl: string): SetupCheckText =>
  text(
    `Add ${callbackUrl} to the app's redirect URLs.`,
    `把 ${callbackUrl} 加到应用的重定向地址（Redirect URLs）里。`,
  );

/**
 * The network rules of the probe: the deployment's egress proxy (`net.httpsProxy` /
 * `net.noProxy`), its private host exemptions (`marketplaces.allowPrivateHosts`, the one list of
 * internal hosts the kernel may reach) and loopback http only under
 * `tools.oauthAllowInsecureLoopback` (tests), as for every other OAuth URL.
 */
export function probeNetPolicy(config: KernelConfig): NetPolicy {
  return {
    allowInsecureLoopback: config.tools.oauthAllowInsecureLoopback,
    allowPrivateHosts: config.marketplaces.allowPrivateHosts,
    trustedOrigins: [],
    ...(config.net.httpsProxy !== undefined && {
      proxy: { url: config.net.httpsProxy, noProxy: config.net.noProxy },
    }),
  };
}

export interface TokenProbeInput {
  /** The stored client: its `tokenEndpoint` is the one the connect flow posts codes to. */
  client: OAuthClientRecord;
  /** The connect flow's redirect URI (`http.publicUrl` + the callback path). */
  redirectUri: string;
  net: NetPolicy;
  /** The run's signal (the kernel's time limit). */
  signal: AbortSignal;
  /** Tests only: the network calls (defaults to {@link safeFetch}). */
  fetch?: typeof safeFetch;
}

/**
 * Probes the token endpoint (spec §10.6 table): `invalid_grant` / Slack `invalid_code` → ok; a
 * refused client (or any other 401) → failing with the copy-again fix; a refused redirect URI →
 * failing with the callback URL; anything else (429, 5xx, a network error, a redirect, a 2xx) →
 * unknown. Never throws, never logs; the answer is read only for its refusal code and dropped.
 */
export async function probeTokenEndpoint(input: TokenProbeInput): Promise<SetupCheckResult> {
  const { client } = input;
  const { headers, body } = tokenRequestInit(client, {
    grant_type: "authorization_code",
    code: PROBE_CODE,
    redirect_uri: input.redirectUri,
    code_verifier: PROBE_VERIFIER,
    resource: client.resource,
  });
  let status: number;
  let parsed: unknown;
  try {
    const res = await (input.fetch ?? safeFetch)(
      client.tokenEndpoint,
      { method: "POST", headers, body: body.toString(), signal: input.signal },
      input.net,
      { maxBytes: PROBE_MAX_BYTES },
    );
    status = res.status;
    // only an answer that can carry a refusal is read (400 / 401, or a 200 error body of
    // dialects like Slack's); other bodies are dropped unread
    if (status === 200 || status === 400 || status === 401) {
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        parsed = undefined;
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
  } catch (e) {
    if (e instanceof NetDeniedError && e.code !== "net.redirect" && e.code !== "net.dns_failed") {
      return { status: "unknown", reason: PROBE_TEXTS.netDenied };
    }
    return { status: "unknown", reason: PROBE_TEXTS.unknown };
  }
  // only the refusal code is taken from the answer; a 2xx token is never looked at or kept
  const code = parseTokenRefusal(status, parsed);
  if (code !== null && ACCEPTED.has(code)) return { status: "ok", reason: PROBE_TEXTS.accepted };
  if (code !== null && REDIRECT_REFUSED.has(code)) {
    return {
      status: "failing",
      reason: PROBE_TEXTS.redirectRefused,
      fix: redirectFix(input.redirectUri),
    };
  }
  if ((code !== null && CLIENT_REFUSED.has(code)) || status === 401) {
    return { status: "failing", reason: PROBE_TEXTS.clientRefused, fix: PROBE_TEXTS.clientFix };
  }
  return { status: "unknown", reason: PROBE_TEXTS.unknown };
}
