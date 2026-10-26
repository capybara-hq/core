import {
  CONNECTOR_EXTENSION_POINT,
  type Connector,
  type ConnectorInspection,
  type ConnectorOpenArgs,
  type ConnectorSession,
  defineExtension,
  type ElicitationRequest,
  type PromptInfo,
  type ToolContent,
  ToolError,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Test fake of a connector extension (`connector@1`, kind `fake`): a deliberately small MCP client
 * (Streamable HTTP) meant for `startFakeMcpServer` from `@capybara-hq/testing`. It covers the
 * kernel side of the connector contract, not MCP edge cases:
 * - `endpointSchema`: `{ url, headers? }`, https or (with `allowInsecureLoopback`, default on)
 *   loopback http; credential headers are rejected;
 * - `auth()` before every request, one `onUnauthorized()` + retry on 401, redirects not followed;
 * - `listTools` puts `{ tool: <remote name> }` into `connectorData`; `callTool` routes by
 *   `ctx.spec.connectorData` when the kernel passes it;
 * - `onToolsChanged` (MCP `tools/list_changed`), `onElicit` (MCP `elicitation/create`), resources
 *   and prompts when the server declares them;
 * - `inspect`: an unauthenticated `tools/list`; a 401 yields a bearer auth hint, success yields
 *   the tools as operations.
 */

/** Model-visible text after the one refresh-and-retry still got 401. */
const AUTH_FAILED_TEXT = "Authentication failed for this connector; ask the user to reconnect it.";

/** Model-visible text when the server cannot be reached. */
const UNREACHABLE_TEXT = "Could not reach the connector's server; retry later.";

const CLIENT_INFO = { name: "capybara-fake-connector", version: "0.1.0" };

/** The kernel's pipeline timeout (through the signal) decides, not the SDK's default 60 s. */
const REQUEST_TIMEOUT_MS = 3_600_000;

const DeploymentConfig = z.object({
  /** Accept http://127.0.0.1 / localhost / [::1] endpoints (on by default: this is a test fake). */
  allowInsecureLoopback: z.boolean().default(true),
});

const isLoopbackHttp = (u: URL): boolean =>
  u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);

const urlAllowed = (raw: string, loopback: boolean): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || (loopback && isLoopbackHttp(u));
  } catch {
    return true; // z.url() reports the format error
  }
};

const isCredentialHeader = (name: string): boolean =>
  ["authorization", "proxy-authorization", "cookie"].includes(name.toLowerCase());

/** The endpoint: the server URL and optional non-secret fixed headers. */
export function fakeEndpointSchema(allowInsecureLoopback: boolean) {
  return z
    .object({
      url: z.url().refine((v) => urlAllowed(v, allowInsecureLoopback), {
        message: "URL must use https (plain http only for loopback hosts)",
      }),
      headers: z
        .record(z.string(), z.string())
        .default({})
        .refine((h) => !Object.keys(h).some(isCredentialHeader), {
          message: "Do not put credentials in endpoint headers; configure the connector auth",
        }),
    })
    .strict();
}

type Endpoint = z.infer<ReturnType<typeof fakeEndpointSchema>>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mapContent(c: unknown): ToolContent {
  if (isObj(c) && c.type === "text") return { type: "text", text: String(c.text ?? "") };
  if (isObj(c) && c.type === "image") {
    return { type: "image", mimeType: String(c.mimeType ?? ""), data: String(c.data ?? "") };
  }
  return { type: "text", text: `[Unsupported content omitted]` };
}

function mapTool(raw: Record<string, unknown>): ToolSpec {
  const name = String(raw.name);
  const description =
    typeof raw.description === "string" && raw.description.trim() !== "" ? raw.description : name;
  return {
    name,
    description,
    inputSchema: isObj(raw.inputSchema) ? raw.inputSchema : {},
    ...(isObj(raw.annotations) && { annotations: raw.annotations }),
    connectorData: { tool: name },
  };
}

/** Maps errors to ToolError (5xx and connection failures count for the kernel's breaker). */
function mapError(e: unknown): unknown {
  if (e instanceof ToolError) return e;
  if (e instanceof McpError) {
    return new ToolError(
      `The connector returned an error: ${e.message.replace(/^(MCP error -?\d+: )+/, "")}; check the arguments and retry.`,
    );
  }
  if (e instanceof StreamableHTTPError && typeof e.code === "number" && e.code >= 400) {
    return new ToolError(`The connector's server responded with HTTP ${e.code}; retry later.`, {
      kind: e.code >= 500 ? "unavailable" : "error",
    });
  }
  if (e instanceof TypeError && e.message === "fetch failed") {
    return new ToolError(UNREACHABLE_TEXT, { kind: "unavailable" });
  }
  return e;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw mapError(e);
  }
}

/** A fetch that injects `auth()` before every request and retries once after `onUnauthorized()`. */
function authedFetch(
  endpoint: Endpoint,
  auth: ConnectorOpenArgs["auth"] | undefined,
  onUnauthorized: ConnectorOpenArgs["onUnauthorized"] | undefined,
  signal: AbortSignal,
) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const send = async (): Promise<Response> => {
      const inj = auth ? await auth() : { headers: {} };
      const url = new URL(input);
      for (const [k, v] of Object.entries(inj.query ?? {})) url.searchParams.set(k, v);
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(endpoint.headers)) if (!headers.has(k)) headers.set(k, v);
      for (const [k, v] of Object.entries(inj.headers)) headers.set(k, v);
      const s = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      return fetch(url, { ...init, headers, signal: s, redirect: "manual" });
    };
    const noRedirect = async (r: Response) => {
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        throw new ToolError(
          `The connector's server responded with a redirect (HTTP ${r.status}); ask an administrator to check the endpoint URL.`,
        );
      }
    };
    let res = await send();
    await noRedirect(res);
    // GET is the optional standalone SSE stream; the SDK ignores its failures
    if (res.status === 401 && method !== "GET" && onUnauthorized) {
      await res.body?.cancel();
      await onUnauthorized();
      res = await send();
      await noRedirect(res);
      if (res.status === 401) {
        await res.body?.cancel();
        throw new ToolError(AUTH_FAILED_TEXT);
      }
    }
    return res;
  };
}

async function connect(
  endpoint: Endpoint,
  fetchImpl: ReturnType<typeof authedFetch>,
  args: Partial<ConnectorOpenArgs> & { signal: AbortSignal },
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), { fetch: fetchImpl });
  const onElicit = args.onElicit;
  const client = new Client(CLIENT_INFO, {
    capabilities: onElicit ? { elicitation: { form: {}, url: {} } } : {},
  });
  client.onerror = () => {};
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params;
      const request: ElicitationRequest =
        p.mode === "url"
          ? { mode: "url", message: p.message, url: p.url, elicitationId: p.elicitationId }
          : {
              mode: "form",
              message: p.message,
              requestedSchema: p.requestedSchema as Record<string, unknown>,
            };
      const r = await onElicit(request);
      return r.action === "accept"
        ? { action: "accept", ...(r.content !== undefined && { content: r.content }) }
        : { action: r.action };
    });
  }
  const onToolsChanged = args.onToolsChanged;
  if (onToolsChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        onToolsChanged();
      } catch {
        // the callback must not fail the call
      }
    });
  }
  try {
    // The SDK's own Transport type does not satisfy exactOptionalPropertyTypes (see connector-mcp)
    const t = transport as unknown as Parameters<Client["connect"]>[0];
    await guarded(() => client.connect(t, { signal: args.signal, timeout: REQUEST_TIMEOUT_MS }));
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return { client, transport };
}

async function openSession(endpoint: Endpoint, args: ConnectorOpenArgs): Promise<ConnectorSession> {
  const fetchImpl = authedFetch(endpoint, args.auth, args.onUnauthorized, args.signal);
  const { client, transport } = await connect(endpoint, fetchImpl, args);
  const opts = (signal: AbortSignal = args.signal) => ({ signal, timeout: REQUEST_TIMEOUT_MS });
  const session: ConnectorSession = {
    listTools: () =>
      guarded(async () => {
        const r = await client.listTools({}, opts());
        return r.tools.map((t) => mapTool(t as Record<string, unknown>));
      }),
    callTool: (name, input, signal, ctx) =>
      guarded(async () => {
        const routed = ctx?.spec.connectorData?.tool;
        const r = (await client.callTool(
          {
            name: typeof routed === "string" ? routed : name,
            arguments: isObj(input) ? input : {},
          },
          undefined,
          opts(AbortSignal.any([signal, args.signal])),
        )) as Record<string, unknown>;
        const content = Array.isArray(r.content) ? r.content.map(mapContent) : [];
        return { content, ...(r.isError === true && { isError: true }) } satisfies ToolResult;
      }),
    async close() {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
  const caps = client.getServerCapabilities();
  if (caps?.resources) {
    session.listResources = () =>
      guarded(async () =>
        (await client.listResources({}, opts())).resources.map((x) => ({
          uri: x.uri,
          name: x.name,
          ...(typeof x.description === "string" && { description: x.description }),
          ...(typeof x.mimeType === "string" && { mimeType: x.mimeType }),
        })),
      );
    session.readResource = (uri) =>
      guarded(async () => {
        const r = await client.readResource({ uri }, opts());
        return {
          content: r.contents.map((c) =>
            "text" in c && typeof c.text === "string"
              ? { type: "text" as const, text: c.text }
              : { type: "text" as const, text: `[Binary resource ${uri} omitted]` },
          ),
        };
      });
  }
  if (caps?.prompts) {
    session.listPrompts = () =>
      guarded(async () =>
        (await client.listPrompts({}, opts())).prompts.map(
          (p): PromptInfo => ({
            name: p.name,
            ...(typeof p.description === "string" && { description: p.description }),
            arguments: (p.arguments ?? []).map((a) => ({
              name: a.name,
              ...(typeof a.required === "boolean" && { required: a.required }),
            })),
          }),
        ),
      );
    session.getPrompt = (name, promptArgs) =>
      guarded(async () => {
        const r = await client.getPrompt({ name, arguments: promptArgs }, opts());
        return {
          messages: r.messages.map((m) => ({
            role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
            content: [mapContent(m.content)],
          })),
        };
      });
  }
  return session;
}

/** Install preview without credentials: 401 -> a bearer hint; otherwise the tools as operations. */
async function inspect(endpoint: Endpoint, signal: AbortSignal): Promise<ConnectorInspection> {
  let unauthorized = false;
  const probe = authedFetch(endpoint, undefined, undefined, signal);
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const r = await probe(input, init);
    if (r.status === 401) unauthorized = true;
    return r;
  };
  try {
    const { client } = await connect(endpoint, fetchImpl, { signal });
    try {
      const tools = (await client.listTools({}, { signal, timeout: REQUEST_TIMEOUT_MS })).tools;
      return {
        authHints: [],
        operations: tools.map((t) => ({
          id: t.name,
          method: "POST",
          path: `/tools/${t.name}`,
          ...(typeof t.description === "string" && { summary: t.description }),
        })),
      };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (e) {
    if (unauthorized) return { authHints: [{ scheme: "bearer", type: "bearer" }] };
    throw mapError(e);
  }
}

/** Creates the fake connector (exported for unit tests that call it without a kernel). */
export function createFakeConnector(allowInsecureLoopback: boolean): Connector {
  const schema = fakeEndpointSchema(allowInsecureLoopback);
  return {
    kind: "fake",
    endpointSchema: schema,
    open: (args) => openSession(schema.parse(args.endpoint), args),
    inspect: ({ endpoint, signal }) => inspect(schema.parse(endpoint), signal),
  };
}

export default defineExtension({
  name: "fake-connector",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CONNECTOR_EXTENSION_POINT],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { allowInsecureLoopback } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(CONNECTOR_EXTENSION_POINT, createFakeConnector(allowInsecureLoopback));
  },
});
