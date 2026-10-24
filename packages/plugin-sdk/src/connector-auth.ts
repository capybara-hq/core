import { z } from "zod";

/*
 * 连接器的认证方式（只有类型与非密钥字段，凭据值不在这里）：内核的连接器安装接口与企业目录里的连接器模板
 * （`ConnectorTemplateSpec.auth`）共用这一个 schema。各分支都是 strict：多出的字段（如 `token`）一律拒绝，
 * 所以合法的认证预设里不可能夹带凭据。OAuth 端点是否必须 https 由内核按部署配置再校验。
 */

/** HTTP 头名（RFC 9110 token）。 */
const HeaderName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name");
const Ownership = z.enum(["org", "personal"]);
/** OAuth 端点（https 等由内核按部署配置再校验）。 */
const OAuthUrl = z.url().max(2000);
/** 令牌端点的客户端认证方式（有客户端密钥时）。 */
const TokenAuthMethod = z.enum(["client_secret_basic", "client_secret_post"]);
/** OAuth scope（RFC 6749 §3.3 scope-token）。 */
const Scopes = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "Invalid scope"),
  )
  .max(50);

/** 认证方式：只有类型与非密钥字段；凭据值走内核的 `credential` / 凭据接口。 */
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
    })
    .strict(),
]);

/** 认证预设（{@link ConnectorAuthSchema} 的输出）。 */
export type ConnectorAuthPreset = z.infer<typeof ConnectorAuthSchema>;
