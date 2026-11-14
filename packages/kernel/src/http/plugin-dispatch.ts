import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Logger, RouteCaller } from "@capybara-hq/plugin-sdk";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import FindMyWay from "find-my-way";
import type { Route } from "../ctx/create-ctx.js";
import { ApiError, ERROR_CODES, errorBody } from "../errors.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../identity/cookies.js";
import { codeForStatus, redactPath } from "./error.filter.js";

/** Every extension route lives under this prefix (`ctx.http.route` adds `/plugins/<name>`). */
export const PLUGIN_PREFIX = "/plugins/";

/**
 * The extension route table: the route record matching a method and path (no query string) with
 * its path parameters; HEAD without a route of its own matches the GET record (its access too).
 */
export interface PluginRouter {
  find(method: string, path: string): { route: Route; params: Record<string, string> } | undefined;
}

/**
 * Resolves the caller of an extension route from its declared access (`PluginRouteAccess`), run
 * in the plugin scope's `onRequest` hook: throws an `ApiError` on refusal, never reads the body.
 * `reply` only takes headers (a 429's `retry-after`).
 */
export interface RouteAccessResolver {
  resolve(
    route: Route,
    req: FastifyRequest,
    reply: FastifyReply,
    params: Record<string, string>,
  ): Promise<RouteCaller>;
}

/**
 * The live source of extension routes (C17): routes change as extension instances are revoked /
 * replaced, and the route table is rebuilt when `revision()` changes.
 * `unavailable(plugin)`: the extension belongs to this deployment but is not in the registry right
 * now (revoked / pending approval / failed to load), and its `/plugins/<plugin>/*` all answer 503
 * `extension.unavailable` (the routes stay mounted and only gate).
 */
export interface PluginRouteTable {
  routes(): Route[];
  revision(): number;
  unavailable(plugin: string): boolean | Promise<boolean>;
  /**
   * 插件实例变化（撤销 / 替换）的通知：转发层据此中止该插件进行中请求的 `req.signal`
   * （SSE 等长连接随之收尾，不留在旧实例上）。返回取消订阅函数。
   */
  onChange?(listener: (plugin: string) => void): () => void;
}

/** 固定的路由列表（测试与只挂一次的调用方）：版本不变、没有不可用的插件。 */
export function staticRouteTable(routes: Route[]): PluginRouteTable {
  return { routes: () => routes, revision: () => 0, unavailable: () => false };
}

/** 路径里的插件名（`/plugins/<name>/...` 的 `<name>`）；不在插件前缀下返回 undefined。 */
export function pluginOfPath(path: string): string | undefined {
  if (!path.startsWith(PLUGIN_PREFIX)) return undefined;
  const name = path.slice(PLUGIN_PREFIX.length).split("/", 1)[0];
  return name === undefined || name === "" ? undefined : name;
}

/**
 * Builds the extension route table with find-my-way (the same path syntax as Fastify); throws for
 * a path outside `/plugins/`.
 */
export function createPluginRouter(routes: Route[]): PluginRouter {
  const router = FindMyWay();
  for (const r of routes) {
    if (!r.path.startsWith(PLUGIN_PREFIX)) {
      throw new Error(`plugin route ${r.method} ${r.path} is outside ${PLUGIN_PREFIX}`);
    }
    router.on(r.method, r.path, () => {}, { route: r });
  }
  const lookup = (m: string, path: string) => {
    const found = router.find(m as FindMyWay.HTTPMethod, path);
    const route = (found?.store as { route: Route } | undefined)?.route;
    return found && route
      ? { route, params: { ...found.params } as Record<string, string> }
      : undefined;
  };
  return {
    find(method, path) {
      return lookup(method, path) ?? (method === "HEAD" ? lookup("GET", path) : undefined);
    },
  };
}

/**
 * Registers `/plugins/*` in its own encapsulated scope and hands each request to the extension handler
 * as a Web `Request`: the scope removes the default parsers and takes every content type as a raw
 * Buffer, so the body the extension gets is the bytes the client sent.
 * Before the body is read (the scope's `onRequest` hook), in this order:
 * - the extension belongs to this deployment but is not in the registry (revoked and so on) -> 503
 *   `extension.unavailable` (its routes are gone, so their access is unknown);
 *   The gate reads the plugin segment decoded (the router decodes too); a malformed escape -> 400
 *   `validation_failed`;
 * - not mounted or no match -> 404 `not_found`; HEAD without its own route uses the GET record
 *   (its access and params) and answers with no body; a `public` / `embed` record matching the
 *   org mount `/plugins/<plugin>/orgs[/...]` (decoded) counts as no match;
 * - the matched record's access is resolved by `access` (authentication, authorization, effective
 *   config, the public write throttle, see plugin-route-access.ts): an `ApiError` answers its
 *   status and envelope, any other failure is logged and answers 500 `internal`. A refusal never
 *   reaches the handler. The match and the caller are kept per request (a WeakMap entry).
 * Then the handler stage:
 * - the handler gets `(webReq, caller)`; the Web request carries no kernel credential (`cap_at` /
 *   `cap_rt` cookies and an `Authorization` header with a `cap_pat_` / `cap_svc_` token are
 *   removed; an embed token stays);
 * - when an extension instance is revoked or replaced, the `req.signal` of that extension's
 *   in-progress requests is aborted (`abortPlugin`, triggered by the route source's `onChange`);
 * - a `Request` that cannot be built (e.g. a malformed Host) -> 400 `validation_failed`, not
 *   logged as an error;
 * - `req.signal` aborts only when the client disconnects before the response is written (not on
 *   normal completion); long-lived handlers use it to unsubscribe;
 * - a throwing handler is logged (path redacted with `redactPath`) and returns 500 `internal` (the
 *   error message is not echoed), except a `model.hook_denied` `ApiError` that escaped from
 *   `ctx.models.embed` (an organization policy hook denied the call, spec B §5.4): a deliberate
 *   outcome, not a failure, so it answers 403 `model.hook_denied` with a generic message (the
 *   policy extension's name and reason are not echoed: the route's caller, possibly anonymous, is
 *   not the org admin who configured the policy).
 * - Fastify's own errors (a body over 1 MiB and so on) are mapped to the error envelope by the
 *   scope's error handler: 4xx by the common error code table (413 `payload_too_large`, 415
 *   `unsupported_media_type` and so on), 5xx are logged and return `internal`.
 * - Shutdown: the returned `abortAll()` aborts the `req.signal` of every in-progress request (the
 *   extension's SSE and other long connections wind down by it without using the http shutdown
 *   budget); requests arriving afterwards start with an aborted `req.signal`. In-progress
 *   AbortControllers are held only for the request's lifetime.
 *   So extension handlers either finish quickly or tolerate the abort (see
 *   .agents/skills/writing-extensions "Extension route matching semantics").
 * Must be called before Nest `app.init()`.
 */
export async function registerPluginDispatch(
  fastify: FastifyInstance,
  getTable: () => PluginRouteTable | undefined,
  log: Logger,
  access: RouteAccessResolver,
): Promise<{ abortAll(): void; abortPlugin(plugin: string): void }> {
  /** In-progress request -> its extension (all aborted at shutdown; one extension's when it changes). */
  const inFlight = new Map<AbortController, string>();
  let stopping = false;
  // the route table, cached per route source revision (rebuilt when an extension is revoked / replaced)
  let cached: { table: PluginRouteTable; revision: number; router: PluginRouter } | undefined;
  const routerOf = (table: PluginRouteTable): PluginRouter => {
    const revision = table.revision();
    if (!cached || cached.table !== table || cached.revision !== revision) {
      cached = { table, revision, router: createPluginRouter(table.routes()) };
    }
    return cached.router;
  };
  /** What `onRequest` established for a request the handler stage may serve. */
  const resolved = new WeakMap<FastifyRequest, { route: Route; caller: RouteCaller }>();

  const authorize = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] as string;
    // the router matches decoded paths (`/plugins/%70/x` is `/plugins/p/x`), so the gate and the
    // org-mount guard read them decoded too; a malformed escape matches nothing
    const decoded = safeDecode(path);
    const rawPlugin = pluginOfPath(path);
    const plugin = rawPlugin === undefined ? undefined : safeDecode(rawPlugin);
    if (decoded === undefined || (rawPlugin !== undefined && plugin === undefined)) {
      return reply.code(400).send(errorBody("validation_failed", "Malformed request"));
    }
    const table = getTable();
    if (table && plugin !== undefined && (await table.unavailable(plugin))) {
      return reply
        .code(503)
        .send(errorBody("extension.unavailable", `Extension ${plugin} is not available right now`));
    }
    const match = table ? routerOf(table).find(req.method, path) : undefined;
    if (!match || catchesOrgMount(match.route, decoded)) {
      return reply.code(404).send(errorBody("not_found", `Route ${req.method} ${path} not found`));
    }
    let caller: RouteCaller;
    try {
      caller = await access.resolve(match.route, req, reply, match.params);
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send(errorBody(err.code, err.message, err.details));
      }
      log.error("plugin route access failed", { method: req.method, path: redactPath(path), err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    }
    resolved.set(req, { route: match.route, caller });
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] as string;
    const entry = resolved.get(req);
    // onRequest answered every request it did not resolve; this is only a guard
    if (!entry) return reply.code(500).send(errorBody("internal", "Internal error"));
    const { route, caller } = entry;
    // Abort `req.signal` only when the connection closes before the response is written (the
    // client disconnected): long-lived handlers (SSE) unsubscribe on it. A close after a finished
    // response does not abort (writableFinished is true).
    const ac = new AbortController();
    inFlight.set(ac, route.plugin);
    if (stopping) ac.abort();
    reply.raw.once("close", () => {
      inFlight.delete(ac);
      if (!reply.raw.writableFinished) ac.abort();
    });
    let webReq: Request;
    try {
      webReq = toWebRequest(req, ac.signal);
    } catch {
      return reply.code(400).send(errorBody("validation_failed", "Malformed request"));
    }
    let res: Response;
    try {
      res = await route.handler(webReq, caller);
    } catch (err) {
      if (err instanceof ApiError && err.code === "model.hook_denied") {
        log.warn("plugin handler refused: a policy hook denied its model call", {
          method: req.method,
          path: redactPath(path),
        });
        return reply
          .code(ERROR_CODES["model.hook_denied"])
          .send(errorBody(err.code, "An organization policy denied this model call"));
      }
      log.error("plugin handler failed", { method: req.method, path: redactPath(path), err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    }
    reply.code(res.status);
    for (const [name, value] of res.headers) {
      if (name !== "set-cookie") reply.header(name, value);
    }
    for (const cookie of res.headers.getSetCookie()) reply.header("set-cookie", cookie);
    if (res.body === null) return reply.send();
    if (req.method === "HEAD") {
      await res.body.cancel().catch(() => {});
      return reply.send();
    }
    return reply.send(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>));
  };

  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: FastifyError, req, reply) => {
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      if (status >= 400 && status < 500) {
        return reply.code(status).send(errorBody(codeForStatus(status), err.message));
      }
      log.error("plugin request failed", { method: req.method, path: redactPath(req.url), err });
      return reply.code(status >= 500 ? status : 500).send(errorBody("internal", "Internal error"));
    });
    // the gate, the match and the access check run before the body is read
    scope.addHook("onRequest", authorize);
    scope.all(`${PLUGIN_PREFIX}*`, handler);
  });
  return {
    abortAll() {
      stopping = true;
      for (const ac of [...inFlight.keys()]) ac.abort();
    },
    abortPlugin(plugin) {
      for (const [ac, p] of [...inFlight]) if (p === plugin) ac.abort();
    },
  };
}

/** `decodeURIComponent`, or undefined for a malformed escape. */
function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/**
 * Defence in depth: `/plugins/<plugin>/orgs[/...]` belongs to the org mount of `member` / `admin`
 * routes (the SDK keeps every declared path out of `/orgs/`), so a `public` / `embed` record
 * that matches it anyway (a `/*` or `/:a/:b/...` pattern) is treated as no match.
 */
function catchesOrgMount(route: Route, decodedPath: string): boolean {
  if (route.access === "member" || route.access === "admin") return false;
  const mount = `${PLUGIN_PREFIX}${route.plugin}/orgs`;
  return decodedPath === mount || decodedPath.startsWith(`${mount}/`);
}

const KERNEL_COOKIES: ReadonlySet<string> = new Set([ACCESS_COOKIE, REFRESH_COOKIE]);

/**
 * Removes the kernel session cookies (`cap_at` / `cap_rt`) from a Cookie header: with them an
 * extension handler could call the kernel API as the user. Returns undefined when nothing is left
 * (no Cookie header is passed on).
 */
export function stripKernelCookies(cookie: string): string | undefined {
  const kept = cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !KERNEL_COOKIES.has(p.split("=", 1)[0]?.trim() ?? ""));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * A kernel API token anywhere in an Authorization value (`Bearer cap_pat_…`, a bare token, a quoted
 * or comma / `=` separated one, ...): matched as a substring, never by its position.
 */
const KERNEL_TOKEN_RE = /cap_(pat|svc)_/i;

/**
 * An `Authorization` header value as the extension handler may see it: undefined (dropped) when it
 * carries a kernel API token (`cap_pat_` / `cap_svc_`), which would let the extension call the
 * kernel API as its owner; anything else (an embed token, a webhook signature) is kept.
 */
export function stripKernelAuthorization(value: string): string | undefined {
  return KERNEL_TOKEN_RE.test(value) ? undefined : value;
}

/**
 * Fastify request -> Web `Request`: array headers joined with `, ` (`set-cookie` kept one by one);
 * no body for GET / HEAD; kernel credentials removed (session cookies, an Authorization header
 * with a kernel token); `signal` aborts when the client disconnects before the response is written.
 */
function toWebRequest(req: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name === "cookie") {
      const kept = stripKernelCookies(Array.isArray(value) ? value.join("; ") : value);
      if (kept !== undefined) headers.set(name, kept);
      continue;
    }
    if (name === "authorization") {
      const kept = stripKernelAuthorization(Array.isArray(value) ? value.join(", ") : value);
      if (kept !== undefined) headers.set(name, kept);
      continue;
    }
    if (Array.isArray(value)) {
      if (name === "set-cookie") for (const v of value) headers.append(name, v);
      else headers.set(name, value.join(", "));
    } else {
      headers.set(name, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body);
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers,
    signal,
    ...(hasBody && { body: req.body as Buffer }),
  });
}
