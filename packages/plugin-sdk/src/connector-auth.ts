import { z } from "zod";

/*
 * A connector's authentication method (only the type and non-secret fields; credential values are
 * not here): the kernel's connector install API and the connector templates in the catalog
 * (`ConnectorTemplateSpec.auth`) share this one schema. Every branch is strict: extra fields (such
 * as `token`) are always rejected,
 * so a valid auth preset cannot smuggle in a credential. Whether OAuth endpoints must be https is
 * checked again by the kernel per deployment config.
 */

/** HTTP header name (RFC 9110 token). */
const HeaderName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name");
const Ownership = z.enum(["org", "personal"]);
/** OAuth endpoint (https etc. is checked again by the kernel per deployment config). */
const OAuthUrl = z.url().max(2000);
/** Client authentication method at the token endpoint (when there is a client secret). */
const TokenAuthMethod = z.enum(["client_secret_basic", "client_secret_post"]);
/** OAuth scope (RFC 6749 §3.3 scope-token). */
const Scopes = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "Invalid scope"),
  )
  .max(50);
/**
 * More `token_type` values the token endpoint may return for a bearer token (case-insensitive;
 * `Bearer` and Slack's `user` are always accepted). The token is still sent as
 * `Authorization: Bearer`. Never `DPoP`: such a token is bound to a key the kernel does not hold.
 */
const TokenTypes = z
  .array(
    z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "Invalid token type")
      .refine((t) => t.toLowerCase() !== "dpop", "DPoP tokens are not bearer tokens"),
  )
  .max(5);

/**
 * Authorization request parameters the kernel sets itself, or that would change what the callback
 * or the token exchange relies on, or that never belong on a URL. `oauth_code`
 * `authorizationParams` cannot use them, nor can the query of a manual `authorizationUrl`; the kernel
 * checks the list again before it builds an authorize URL.
 */
export const OAUTH_RESERVED_AUTHORIZATION_PARAMS = [
  // set by the kernel's authorize request
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
  // would change what the callback or the token exchange relies on
  "response_mode",
  "request",
  "request_uri",
  "nonce",
  "dpop_jkt",
  "authorization_details",
  // credentials and token-endpoint names
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "code",
  "code_verifier",
  "grant_type",
  "refresh_token",
] as const;

const RESERVED_PARAMS: ReadonlySet<string> = new Set(OAUTH_RESERVED_AUTHORIZATION_PARAMS);
const reservedParamMessage = (name: string) =>
  `"${name}" is set by the kernel and cannot be an authorization parameter`;
const MAX_AUTHORIZATION_PARAMS = 10;

/**
 * Extra query parameters of the authorize request (e.g. Google's `access_type: "offline"`,
 * `prompt: "consent"`): names `[a-z][a-z0-9_]` up to 40 characters, values 1-200 printable ASCII
 * characters, at most 10, none of {@link OAUTH_RESERVED_AUTHORIZATION_PARAMS}. Not secrets: they
 * are stored in plain JSON and shown in the browser's address bar.
 */
const AuthorizationParams = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Invalid authorization parameter name"),
    z.string().regex(/^[\x20-\x7E]{1,200}$/, "Invalid authorization parameter value"),
  )
  .refine((p) => Object.keys(p).length <= MAX_AUTHORIZATION_PARAMS, {
    message: `At most ${MAX_AUTHORIZATION_PARAMS} authorization parameters`,
  })
  .describe(
    "Extra query parameters of the OAuth authorize request (e.g. access_type, prompt). " +
      "Never put a secret here.",
  );

/**
 * Authentication method: only the type and non-secret fields; credential values go through the
 * kernel's `credential` / credentials API.
 */
export const ConnectorAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer"), ownership: Ownership }).strict(),
  z
    .object({
      type: z.literal("api_key"),
      ownership: Ownership,
      in: z.enum(["header", "query"]),
      name: z.string().min(1).max(100),
    })
    .strict()
    .refine((a) => a.in === "query" || HeaderName.safeParse(a.name).success, {
      path: ["name"],
      message: "Invalid header name",
    }),
  z.object({ type: z.literal("basic"), ownership: Ownership }).strict(),
  z
    .object({
      type: z.literal("headers"),
      ownership: Ownership,
      names: z.array(HeaderName).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth_code"),
      ownership: z.literal("personal"),
      discovery: z.enum(["mcp", "manual"]),
      authorizationUrl: OAuthUrl.optional(),
      tokenUrl: OAuthUrl.optional(),
      scopes: Scopes.optional(),
      client: z.enum(["dcr", "manual"]),
      tokenAuthMethod: TokenAuthMethod.optional(),
      tokenTypes: TokenTypes.optional(),
      authorizationParams: AuthorizationParams.optional(),
    })
    .strict()
    .superRefine((a, ctx) => {
      for (const name of Object.keys(a.authorizationParams ?? {})) {
        if (RESERVED_PARAMS.has(name))
          ctx.addIssue({
            code: "custom",
            path: ["authorizationParams", name],
            message: reservedParamMessage(name),
          });
      }
      // A query in a manual endpoint stays (RFC 6749 §3.1), but never with a name the kernel owns
      if (a.authorizationUrl !== undefined && URL.canParse(a.authorizationUrl)) {
        for (const name of new Set(new URL(a.authorizationUrl).searchParams.keys())) {
          if (RESERVED_PARAMS.has(name.toLowerCase()))
            ctx.addIssue({
              code: "custom",
              path: ["authorizationUrl"],
              message: reservedParamMessage(name),
            });
        }
      }
      if (a.discovery === "manual") {
        for (const k of ["authorizationUrl", "tokenUrl"] as const) {
          if (a[k] === undefined)
            ctx.addIssue({ code: "custom", path: [k], message: "Required with discovery manual" });
        }
      } else {
        for (const k of ["authorizationUrl", "tokenUrl"] as const) {
          if (a[k] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: [k],
              message: "Endpoints are discovered with discovery mcp; omit this field",
            });
        }
      }
      if (a.client === "dcr" && a.discovery !== "mcp") {
        ctx.addIssue({
          code: "custom",
          path: ["client"],
          message: "Dynamic client registration requires discovery mcp",
        });
      }
    }),
  z
    .object({
      type: z.literal("oauth_client"),
      ownership: z.literal("org"),
      tokenUrl: OAuthUrl,
      scopes: Scopes.optional(),
      tokenAuthMethod: TokenAuthMethod.optional(),
      tokenTypes: TokenTypes.optional(),
    })
    .strict(),
]);

/** Auth preset (the output of {@link ConnectorAuthSchema}). */
export type ConnectorAuthPreset = z.infer<typeof ConnectorAuthSchema>;
