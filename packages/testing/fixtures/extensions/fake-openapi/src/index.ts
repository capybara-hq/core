import {
  type AuthHint,
  CONNECTOR_EXTENSION_POINT,
  type Connector,
  type ConnectorInspection,
  type ConnectorOpenArgs,
  type ConnectorSession,
  defineExtension,
  ToolError,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of an OpenAPI-style connector extension (`connector@1`, kind `openapi`): the kind the
 * web install wizard drives with a spec URL, an auth step prefilled from the document's security
 * schemes and an operations table. It stands in for the official `connector-openapi` in core's
 * tests (the web e2e loads it next to `fake-connector`, which is kind `mcp` there; one extension
 * provides an extension point once, so the two kinds need two fakes). It reads a small JSON
 * document instead of OpenAPI:
 *
 * ```json
 * { "securitySchemes": { "<scheme>": { "type": "api_key", "in": "header", "name": "X-API-Key" } },
 *   "baseUrl": "https://…",
 *   "operations": [{ "name": "createPet", "method": "POST", "path": "/pets", "summary": "…",
 *                    "annotations": { "readOnlyHint": false } }] }
 * ```
 *
 * - `endpointSchema`: `{ specUrl, baseUrl?, operations? }` (the wizard's OpenAPI endpoint without
 *   `specText`), https or (with `allowInsecureLoopback`, default on) loopback http;
 * - `inspect`: the document's security schemes as auth hints (`{ scheme, ...value }`) and its
 *   operations (`id` = name);
 * - a session lists one tool per operation (all, or the endpoint's `operations`), named by the
 *   operation, with input `{ body? }` and `connectorData` `{ method, path }`; a call sends the
 *   method to `baseUrl` (endpoint, else document, else the spec URL's origin) + path with `auth()`
 *   injected (one `onUnauthorized()` + retry on 401), the JSON `body`, and no redirects. A 4xx is a
 *   tool error result (`HTTP <status>: <body>`); a 5xx or an unreachable server is a ToolError of
 *   kind `unavailable`.
 */

const DeploymentConfig = z.object({
  /** Accept http://127.0.0.1 / localhost / [::1] URLs (on by default: this is a test fake). */
  allowInsecureLoopback: z.boolean().default(true),
});

const isLoopbackHttp = (u: URL): boolean =>
  u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);

const urlOk = (raw: string, loopback: boolean): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || (loopback && isLoopbackHttp(u));
  } catch {
    return true; // z.url() reports the format error
  }
};

/** The endpoint: the document URL, an optional API base URL and the selected operations. */
export function fakeOpenApiEndpointSchema(allowInsecureLoopback: boolean) {
  const url = z.url().refine((v) => urlOk(v, allowInsecureLoopback), {
    message: "URL must use https (plain http only for loopback hosts)",
  });
  return z
    .object({
      specUrl: url,
      baseUrl: url.optional(),
      operations: z.array(z.string().min(1)).optional(),
    })
    .strict();
}

type Endpoint = z.infer<ReturnType<typeof fakeOpenApiEndpointSchema>>;

const Scheme = z.union([
  z.object({ type: z.literal("api_key"), in: z.enum(["header", "query"]), name: z.string() }),
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("basic") }),
]);

const Operation = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  summary: z.string().optional(),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
    })
    .optional(),
});

const Doc = z.object({
  securitySchemes: z.record(z.string(), Scheme).default({}),
  baseUrl: z.url().optional(),
  operations: z.array(Operation),
});

type Doc = z.infer<typeof Doc>;

const UNREACHABLE_TEXT = "Could not reach the connector's server; retry later.";
const AUTH_FAILED_TEXT = "Authentication failed for this connector; ask the user to reconnect it.";

/** Reads the operations document (no credentials: like an OpenAPI document, it is public). */
async function loadDoc(endpoint: Endpoint, signal: AbortSignal): Promise<Doc> {
  let res: Response;
  try {
    res = await fetch(endpoint.specUrl, { signal, redirect: "manual" });
  } catch {
    throw new ToolError(UNREACHABLE_TEXT, { kind: "unavailable" });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ToolError(`The spec URL answered HTTP ${res.status}; check the endpoint.`);
  }
  const parsed = Doc.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ToolError(
      "The spec URL did not return a valid operations document; check the endpoint's specUrl.",
    );
  }
  return parsed.data;
}

const hintsOf = (doc: Doc): AuthHint[] =>
  Object.entries(doc.securitySchemes).map(([scheme, s]) => ({ scheme, ...s }));

const selected = (doc: Doc, endpoint: Endpoint) =>
  endpoint.operations === undefined
    ? doc.operations
    : doc.operations.filter((o) => endpoint.operations?.includes(o.name));

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "object", description: "JSON request body, for operations that take one." },
  },
  additionalProperties: false,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function openSession(endpoint: Endpoint, args: ConnectorOpenArgs): Promise<ConnectorSession> {
  const doc = await loadDoc(endpoint, args.signal);
  const base = endpoint.baseUrl ?? doc.baseUrl ?? new URL(endpoint.specUrl).origin;
  const ops = selected(doc, endpoint);
  return {
    listTools: async () =>
      ops.map(
        (o): ToolSpec => ({
          name: o.name,
          description: o.summary ?? `${o.method} ${o.path}`,
          inputSchema: INPUT_SCHEMA,
          ...(o.annotations !== undefined && {
            annotations: Object.fromEntries(
              Object.entries(o.annotations).filter(([, v]) => v !== undefined),
            ) as NonNullable<ToolSpec["annotations"]>,
          }),
          connectorData: { method: o.method, path: o.path },
        }),
      ),
    async callTool(name, input, signal, ctx) {
      const data = ctx?.spec.connectorData;
      const op = ops.find((o) => o.name === name);
      const method = typeof data?.method === "string" ? data.method : op?.method;
      const path = typeof data?.path === "string" ? data.path : op?.path;
      if (method === undefined || path === undefined) {
        throw new ToolError(`Unknown operation ${name}; check the tool name and retry.`);
      }
      const body = isObj(input) && isObj(input.body) ? JSON.stringify(input.body) : undefined;
      const send = async (): Promise<Response> => {
        const inj = await args.auth();
        const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
        for (const [k, v] of Object.entries(inj.query ?? {})) url.searchParams.set(k, v);
        const headers = new Headers(inj.headers);
        if (body !== undefined) headers.set("content-type", "application/json");
        try {
          return await fetch(url, {
            method,
            headers,
            ...(body !== undefined && { body }),
            signal: AbortSignal.any([signal, args.signal]),
            redirect: "manual",
          });
        } catch (e) {
          if (signal.aborted || args.signal.aborted) throw e;
          throw new ToolError(UNREACHABLE_TEXT, { kind: "unavailable" });
        }
      };
      let res = await send();
      if (res.status === 401) {
        await res.body?.cancel();
        await args.onUnauthorized();
        res = await send();
        if (res.status === 401) {
          await res.body?.cancel();
          throw new ToolError(AUTH_FAILED_TEXT);
        }
      }
      const text = await res.text();
      if (res.status >= 500) {
        throw new ToolError(
          `The connector's server responded with HTTP ${res.status}; retry later.`,
          {
            kind: "unavailable",
          },
        );
      }
      if (res.status >= 300) {
        return {
          content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }],
          isError: true,
        } satisfies ToolResult;
      }
      return { content: [{ type: "text", text }] } satisfies ToolResult;
    },
    async close() {},
  };
}

async function inspect(endpoint: Endpoint, signal: AbortSignal): Promise<ConnectorInspection> {
  const doc = await loadDoc(endpoint, signal);
  return {
    authHints: hintsOf(doc),
    operations: doc.operations.map((o) => ({
      id: o.name,
      method: o.method,
      path: o.path,
      ...(o.summary !== undefined && { summary: o.summary }),
    })),
  };
}

/** Creates the fake OpenAPI connector (exported for unit tests that call it without a kernel). */
export function createFakeOpenApiConnector(allowInsecureLoopback: boolean): Connector {
  const schema = fakeOpenApiEndpointSchema(allowInsecureLoopback);
  return {
    kind: "openapi",
    endpointSchema: schema,
    open: (args) => openSession(schema.parse(args.endpoint), args),
    inspect: ({ endpoint, signal }) => inspect(schema.parse(endpoint), signal),
  };
}

export default defineExtension({
  name: "fake-openapi",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [CONNECTOR_EXTENSION_POINT],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { allowInsecureLoopback } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(CONNECTOR_EXTENSION_POINT, createFakeOpenApiConnector(allowInsecureLoopback));
  },
});
