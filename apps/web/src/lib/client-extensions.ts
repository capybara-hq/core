import { apiFetch } from "./api";

/**
 * Client extensions (client extensions spec `docs/superpowers/specs/2026-11-09-client-extensions-design.md`
 * §9-§11): the shell read's types and loaders, the report route, safe mode and the client scope of
 * a path. Types copied from the kernel's `packages/kernel/src/client/client.schemas.ts` (the web
 * imports no kernel or SDK code); keep them in step.
 */

/** One file URL of a client build, with the integrity recorded when the package was stored. */
export interface ClientFileRef {
  url: string;
  integrity: string;
}

/** One extension of a shell read: its build's files and the components the viewer may use. */
export interface ClientExtensionItem {
  plugin: string;
  /** The package sha256: the build id in the file URLs. */
  build: string;
  entry: ClientFileRef | null;
  /** Empty in the admin set (spec §9.6). */
  styles: ClientFileRef[];
  components: { id: string; slot: string }[];
}

/** The shell read (spec §9.2). */
export interface ClientExtensionsResponse {
  /** False under the kill switch: `items` is then empty. */
  enabled: boolean;
  /** The kernel's `CLIENT_API_VERSION`, echoed for diagnostics. */
  apiVersion: number;
  items: ClientExtensionItem[];
}

/** `GET /api/v1/orgs/:orgId/ui/client`: the org's client extensions for the viewer. */
export const getOrgClientExtensions = (orgId: string) =>
  apiFetch<ClientExtensionsResponse>(`/api/v1/orgs/${encodeURIComponent(orgId)}/ui/client`);

/** `GET /api/v1/admin/ui/client?plugin=`: the platform set of one plugin's `platform.page`. */
export const getAdminClientExtensions = (plugin: string) =>
  apiFetch<ClientExtensionsResponse>(
    `/api/v1/admin/ui/client?plugin=${encodeURIComponent(plugin)}`,
  );

/** What a crash or load report says (spec §10.4). */
export type ClientReportKind = "load" | "render" | "event" | "api" | "budget";
export interface ClientReport {
  plugin: string;
  build: string;
  contribution: string | null;
  kind: ClientReportKind;
  /** The error's message only (no stack, no page data), at most 500 characters. */
  message: string;
}

/** Where the reports of a document go: the org route on workspace pages, the admin one on admin pages. */
export type ClientReportScope = { kind: "org"; orgId: string } | { kind: "admin" };

/** The longest report message the kernel takes. */
export const REPORT_MESSAGE_MAX = 500;

/** `POST …/ui/client/reports`. */
export const postClientReport = (scope: ClientReportScope, report: ClientReport) =>
  apiFetch<unknown>(
    scope.kind === "org"
      ? `/api/v1/orgs/${encodeURIComponent(scope.orgId)}/ui/client/reports`
      : "/api/v1/admin/ui/client/reports",
    { method: "POST", body: JSON.stringify(report) },
  );

/** The query parameter of safe mode (spec §10.1): `?safe-ui=1`. */
export const SAFE_UI_PARAM = "safe-ui";

/**
 * The session cookie that keeps safe mode on for the browser session (spec §10.1, fix-round ruling):
 * set by the proxy on any document requested with `?safe-ui=1`, cleared by `?safe-ui=0` and by
 * the banner's exit. No Max-Age: it ends with the browser session. Not HttpOnly: the banner clears
 * it before its reload.
 */
export const SAFE_UI_COOKIE = "cap_safe_ui";

/** The `safe-ui` value of a path's query: `"1"`, `"0"` or null. */
function safeUiParam(pathWithQuery: string): string | null {
  const q = pathWithQuery.split("#")[0]?.split("?")[1];
  return q === undefined ? null : new URLSearchParams(q).get(SAFE_UI_PARAM);
}

/** Whether a path with its query (`/agents?safe-ui=1`) asks for safe mode. */
export function isSafeUi(pathWithQuery: string): boolean {
  return safeUiParam(pathWithQuery) === "1";
}

/**
 * Whether a request renders in safe mode: `?safe-ui=1`, or the session cookie unless the query
 * says `safe-ui=0` (the request that ends it still carries the cookie).
 */
export function safeUiOf(pathWithQuery: string, cookieHeader: string | null): boolean {
  const param = safeUiParam(pathWithQuery);
  if (param === "1") return true;
  if (param === "0") return false;
  return (cookieHeader ?? "").split(";").some((c) => c.trim() === `${SAFE_UI_COOKIE}=1`);
}

/** The `Set-Cookie` a document request's query asks for (on, off), or null. */
export function safeUiCookieFor(pathWithQuery: string, https: boolean): string | null {
  const param = safeUiParam(pathWithQuery);
  const secure = https ? "; Secure" : "";
  if (param === "1") return `${SAFE_UI_COOKIE}=1; Path=/; SameSite=Lax${secure}`;
  if (param === "0") return `${SAFE_UI_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  return null;
}

/** Ends safe mode in this browser (the banner's exit, before it reloads without the parameter). */
export function clearSafeUiCookie(): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and not everywhere
    document.cookie = `${SAFE_UI_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch {
    // a blocked cookie jar: the reload carries safe-ui=0, which the proxy clears it with
  }
}

/** The same URL with safe mode on (`withSafeUi(href, true)`) or off. */
export function withSafeUi(href: string, on = true): string {
  const url = new URL(href, "http://x");
  if (on) url.searchParams.set(SAFE_UI_PARAM, "1");
  else url.searchParams.delete(SAFE_UI_PARAM);
  const abs = /^[a-z][a-z0-9+.-]*:/i.test(href);
  return abs ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/** The admin console's platform page of a plugin (`/admin/p/<plugin>/<id>`). */
const PLATFORM_PAGE = /^\/admin\/p\/([^/]+)\/[^/]+\/?$/;

/**
 * Which client set a page loads (spec §9.6): the org set on workspace pages (`org`), nothing on
 * the admin console (`admin`), the platform set of one plugin on its page (`admin-p:<plugin>`).
 */
export type ClientScopeKey = "org" | "admin" | `admin-p:${string}`;

export function clientScopeOf(pathname: string): ClientScopeKey {
  const page = PLATFORM_PAGE.exec(pathname);
  if (page?.[1] !== undefined) {
    let plugin = page[1];
    try {
      plugin = decodeURIComponent(plugin);
    } catch {
      // a malformed escape: keep the raw segment (it names no plugin anyway)
    }
    return `admin-p:${plugin}`;
  }
  return pathname === "/admin" || pathname.startsWith("/admin/") ? "admin" : "org";
}

/** Whether a set carries anything to load: an entry or a stylesheet. */
export function setHasCode(set: ClientExtensionsResponse | null | undefined): boolean {
  return set?.enabled === true && set.items.some((i) => i.entry !== null || i.styles.length > 0);
}
