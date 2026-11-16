import { z } from "zod";

/*
 * A connector's authentication method (only the type and non-secret fields; credential values are not here): the kernel's connector install API and the connector templates in the enterprise catalog
 * (`ConnectorTemplateSpec.auth`) share this one schema. Every branch is strict: extra fields (such as `token`) are always rejected,
 * so a valid auth preset cannot smuggle in a credential. Whether OAuth endpoints must be https is checked again by the kernel per deployment config.
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

/** Authentication method: only the type and non-secret fields; credential values go through the kernel's `credential` / credentials API. */
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
    })
    .strict()
    .superRefine((a, ctx) => {
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
