import { signedInTarget } from "./auth-sources";
import { kernelUrl, readBody } from "./kernel-proxy";
import { trustedPeer } from "./peer";
import { HOME_PATH } from "./routes";

/**
 * Native form submissions to pages (the proxy, `src/proxy.ts`). Every `<form>` posts
 * (`method="post"`, the `web-ui-form-method` check), so when the client JS does not load (a dev
 * origin Next blocks, a script error, JS turned off) the browser sends the fields in the body,
 * never in the URL. This module answers such a POST without the page: sign-in and setup run their
 * whole flow server side (the kernel call, the session cookies, a 303 on), any other page's form
 * gets a 303 back to the page without its body being read. Request bodies are never logged or
 * echoed. Pure of Next, so it is tested without a server.
 */

/** The page whose native POST signs in. */
export const LOGIN_PATH = "/login";
/** The page whose native POST completes the setup wizard. */
export const SETUP_PATH = "/setup";

/** Form field names that must never stay in a page URL (a GET submission of an old page). */
const CREDENTIAL_PARAMS = ["login", "password", "setupToken", "displayName", "orgName"] as const;
/** The public pages whose forms carry credentials. */
const CREDENTIAL_PAGES = [LOGIN_PATH, SETUP_PATH, "/invite"] as const;

/** A form body is small; anything bigger is not one of ours. */
const MAX_FORM_BYTES = 16 * 1024;
/** How long the sign-in / setup call waits for the kernel. */
const KERNEL_TIMEOUT_MS = 10_000;

/** The sign-in failures the sign-in page explains (`LOGIN_ERROR_CODES`); the rest read `unknown`. */
const LOGIN_FAILURES = new Set([
  "auth.invalid_credentials",
  "auth.rate_limited",
  "auth.account_disabled",
]);

/** Whether a request is a browser's native form submission to a page (not a Next server action). */
export function isNativeFormPost(req: Request): boolean {
  if (req.method !== "POST" || req.headers.has("next-action")) return false;
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  return (
    type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data")
  );
}

/**
 * Whether the submission comes from a page of this site: `Sec-Fetch-Site: same-origin` when the
 * browser sends it, else an `Origin` whose host is the request's. Neither: refused (every current
 * browser sends one of them on a form POST), so another site cannot sign a visitor in to its own
 * account.
 */
function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (origin === null || origin === "null") return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const seeOther = (location: string, setCookies: readonly string[] = []): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
};

/** `search` without the credential fields and `error`, plus `error` when given. */
function cleanSearch(search: string, error?: string): string {
  const q = new URLSearchParams(search);
  for (const k of CREDENTIAL_PARAMS) q.delete(k);
  q.delete("error");
  if (error !== undefined) q.set("error", error);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** The urlencoded fields of a form POST, or `undefined` (another encoding, too large, unreadable). */
async function formFields(req: Request): Promise<URLSearchParams | undefined> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  try {
    const body = await readBody(req, MAX_FORM_BYTES);
    return body === undefined ? undefined : new URLSearchParams(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** A kernel call made for the browser: its address and user agent go along, as the proxy does. */
async function callKernel(
  req: Request,
  path: string,
  body: unknown,
): Promise<Response | undefined> {
  const headers = new Headers({ "content-type": "application/json", "x-capybara-csrf": "1" });
  const peer = trustedPeer(req.headers);
  if (peer !== undefined) headers.set("x-forwarded-for", peer);
  const ua = req.headers.get("user-agent");
  if (ua !== null) headers.set("user-agent", ua);
  try {
    return await fetch(`${kernelUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(KERNEL_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

/** The error code of a kernel error response (only a plain code; anything else is `unknown`). */
async function errorCode(res: Response): Promise<string> {
  try {
    const code = ((await res.json()) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
}

async function loginPost(req: Request, search: string): Promise<Response> {
  const failed = (code: string) =>
    seeOther(`${LOGIN_PATH}${cleanSearch(search, LOGIN_FAILURES.has(code) ? code : "unknown")}`);
  if (!sameOrigin(req)) return failed("unknown");
  const fields = await formFields(req);
  if (fields === undefined) return failed("unknown");
  const res = await callKernel(req, "/api/v1/auth/login", {
    login: fields.get("login") ?? "",
    password: fields.get("password") ?? "",
  });
  if (res === undefined) return failed("unknown");
  if (!res.ok) return failed(await errorCode(res));
  await res.body?.cancel().catch(() => {});
  // the same target a signed-in visitor of this sign-in page gets: a safe `returnTo`, no loop
  return seeOther(signedInTarget(`${LOGIN_PATH}${search}`), res.headers.getSetCookie());
}

async function setupPost(req: Request): Promise<Response> {
  const failed = (code: string) => seeOther(`${SETUP_PATH}?error=${encodeURIComponent(code)}`);
  if (!sameOrigin(req)) return failed("unknown");
  const fields = await formFields(req);
  if (fields === undefined) return failed("unknown");
  const text = (name: string) => (fields.get(name) ?? "").trim();
  const input: Record<string, string> = {
    login: text("login"),
    password: fields.get("password") ?? "",
    displayName: text("displayName"),
  };
  if (text("orgName") !== "") input.orgName = text("orgName");
  if (text("setupToken") !== "") input.setupToken = text("setupToken");
  const res = await callKernel(req, "/api/v1/setup", input);
  if (res === undefined) return failed("upstream_unavailable");
  if (!res.ok) return failed(await errorCode(res));
  await res.body?.cancel().catch(() => {});
  return seeOther(HOME_PATH, res.headers.getSetCookie());
}

/**
 * Answers a native form POST to the page at `pathname` (`isNativeFormPost`): sign-in and setup run
 * their flow, any other page gets a 303 back to itself (its body is never read).
 */
export function handleFormPost(req: Request, pathname: string, search: string): Promise<Response> {
  if (pathname === LOGIN_PATH) return loginPost(req, search);
  if (pathname === SETUP_PATH) return setupPost(req);
  return Promise.resolve(seeOther(`${pathname}${search}`));
}

/**
 * Where to send a GET of a credential page whose query holds form fields (a native GET submission
 * from a page without `method="post"`, or a crafted link): the same page without them, never
 * signing in. `undefined` when the query is clean.
 */
export function credentialQueryRedirect(pathname: string, search: string): Response | undefined {
  if (!CREDENTIAL_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return undefined;
  }
  const q = new URLSearchParams(search);
  if (!CREDENTIAL_PARAMS.some((k) => q.has(k))) return undefined;
  return seeOther(`${pathname}${cleanSearch(search, q.get("error") ?? undefined)}`);
}
