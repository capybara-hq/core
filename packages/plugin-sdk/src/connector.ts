import type { ZodTypeAny } from "zod";
import type { FormAnswer, ToolContent, ToolResult, ToolSpec } from "./tool.js";

/** Authentication information injected into outbound requests. */
export interface AuthInjection {
  headers: Record<string, string>;
  query?: Record<string, string>;
}

/** One session between the connector and the remote service. */
export interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  /**
   * `ctx.spec`: the already-reviewed definition of this tool in the kernel snapshot (`connector_tools.spec`, never a new definition awaiting review), including the `connectorData` given at listTools.
   * The connector should route the call by it rather than re-reading the remote description (remote changes must pass drift review first). Old kernels do not pass it; check for absence.
   */
  callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
    ctx?: { spec: ToolSpec },
  ): Promise<ToolResult>;
  listResources?(): Promise<
    { uri: string; name: string; description?: string; mimeType?: string }[]
  >;
  readResource?(uri: string): Promise<ToolResult>;
  /** Optional: prompt templates the remote provides (e.g. MCP prompts). Do not implement when unsupported; the kernel must check for absence. */
  listPrompts?(): Promise<PromptInfo[]>;
  /** Optional: renders a prompt template with arguments and returns messages (e.g. MCP `prompts/get`). On failure throw ToolError (English, no credentials). */
  getPrompt?(name: string, args: Record<string, string>): Promise<RenderedPrompt>;
  close(): Promise<void>;
}

/** A remote prompt template (the `/connector:promptName` slash command). */
export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}

/** A rendered prompt: messages in order, content blocks the same as tool results (non-text gets a type description). */
export interface RenderedPrompt {
  description?: string;
  messages: { role: "user" | "assistant"; content: ToolContent[] }[];
}

/**
 * The remote asks the user for input in the middle of a call (MCP `elicitation/create`):
 * - `form`: `requestedSchema` is the flat JSON Schema the remote gives (object + primitive-typed properties), which the kernel maps to an interactive form;
 * - `url`: asks the user to open `url` in a browser to complete a step (authorization, payment, entering sensitive information); the user confirms whether it was completed.
 */
export type ElicitationRequest =
  | { mode: "form"; message: string; requestedSchema: Record<string, unknown> }
  | { mode: "url"; message: string; url: string; elicitationId: string };

/** The reply to an elicitation (corresponds to MCP `ElicitResult`): accept (with form content) / decline / cancel. */
export type ElicitationResponse =
  | { action: "accept"; content?: FormAnswer }
  | { action: "decline" }
  | { action: "cancel" };

/** Parameters the kernel passes to the connector when it opens a session. */
export interface ConnectorOpenArgs {
  /** Already validated against endpointSchema. */
  endpoint: unknown;
  /** Called before every request; refreshing credentials is the kernel's job. */
  auth: () => Promise<AuthInjection>;
  /** Called once on a 401; after the kernel refreshes credentials the plugin retries once. */
  onUnauthorized: () => Promise<void>;
  signal: AbortSignal;
  /**
   * Called when the remote reports during the session that its tool list changed (e.g. MCP `notifications/tools/list_changed`), possibly several times; the kernel schedules one
   * drift check from it (new / changed tools are unavailable until an admin reviews them). Optional: old kernels do not provide it, so the connector must check for absence. Do not wait for it and do not throw because of it.
   */
  onToolsChanged?: () => void;
  /**
   * Called when the remote asks the user for input mid-call (MCP `elicitation/create`, the URL-mode
   * `-32042` error); the connector passes the returned answer back to the remote as is. Optional:
   * when the kernel does not provide it, the connector does not declare the MCP elicitation
   * capability (so the remote never starts one).
   *
   * The kernel cannot hold a remote call while waiting for the user to answer (the run pauses, the worker is released, the session closes): when the user must be asked, the kernel **aborts this call**
   * (via the `callTool` signal) and puts the run into waiting; after the user answers the kernel issues the same call again, and when the remote raises the same elicitation again
   * this callback replies at once with the user's answer. So the connector only needs "call it when received, return what it gets"; do not cache or retry yourself; when the user must be asked this callback
   * rejects with an error (the call has already been aborted), and the connector simply lets that error end this call unchanged.
   */
  onElicit?: (request: ElicitationRequest) => Promise<ElicitationResponse>;
}

/**
 * An authentication method declared in the remote description, mapped to the shape of the kernel's connector auth (ConnectorAuth), to prefill the install wizard.
 * `scheme` is the name in the remote description (e.g. the key of OpenAPI `securitySchemes`), `description` is given as is (may be absent).
 * Only methods the kernel supports are listed; the rest (API keys in cookies, OpenID Connect, implicit / password flows, etc.) do not appear.
 */
export type AuthHint = { scheme: string; description?: string } & (
  | { type: "bearer" }
  | { type: "basic" }
  | { type: "api_key"; in: "header" | "query"; name: string }
  | { type: "oauth_client"; tokenUrl: string; scopes: string[] }
  | { type: "oauth_code"; authorizationUrl: string; tokenUrl: string; scopes: string[] }
);

/** An operation in the remote description (e.g. an OpenAPI operation), for the install wizard to tick. */
export interface ConnectorOperation {
  /** The id used for ticking in the endpoint config (e.g. OpenAPI's operationId). */
  id: string;
  /** Uppercase HTTP method. */
  method: string;
  path: string;
  summary?: string;
}

/** The result of `Connector.inspect`. */
export interface ConnectorInspection {
  authHints: AuthHint[];
  operations?: ConnectorOperation[];
}

/** `connector@1`: implemented by the plugin, called by the kernel. */
export interface Connector {
  kind: string;
  endpointSchema: ZodTypeAny;
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
  /**
   * Optional: reads the endpoint's description without credentials (for the install wizard preview), returning the declared auth methods and an optional operation list.
   * `endpoint` is already validated against endpointSchema. On failure throw ToolError (message in English, no credentials). Old connectors do not implement it; the kernel must check for absence.
   */
  inspect?(args: { endpoint: unknown; signal: AbortSignal }): Promise<ConnectorInspection>;
}
