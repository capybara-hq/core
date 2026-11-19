import { z } from "zod";
import { createZodDto } from "../infra/validation/create-zod-dto.js";

/** Text without control, format or unassigned characters (it lands in a user agent and the audit). */
const PRINTABLE_RE = /^[^\p{C}]+$/u;
const printable = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(PRINTABLE_RE, { message: "Must contain only printable characters" });

/**
 * `POST /api/v1/app-auth/authorize` (desktop client spec §6.5): the person consents on the web to
 * sign a native app in. `codeChallenge` is BASE64URL(SHA-256(verifier)), always 43 characters;
 * only the `S256` method exists. `deny` answers the `error=access_denied` redirect instead.
 */
export const AppAuthorizeBodySchema = z
  .object({
    client: z.literal("desktop"),
    redirectUri: z.string().min(1).max(2048),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, {
      message: "Must be the base64url SHA-256 of the code verifier (43 characters)",
    }),
    codeChallengeMethod: z.literal("S256"),
    state: printable(512),
    name: printable(64),
    appVersion: printable(32),
    deny: z.boolean().optional(),
  })
  .strict();
export type AppAuthorizeBody = z.infer<typeof AppAuthorizeBodySchema>;
export class AppAuthorizeBodyDto extends createZodDto(AppAuthorizeBodySchema, "AppAuthorizeBody") {}

/**
 * `POST /api/v1/app-auth/token`: the app exchanges the one-time code with its PKCE verifier. Only
 * the shape is checked here; every content failure answers `app_auth.code_invalid` (the service).
 */
export const AppTokenBodySchema = z
  .object({
    code: z.string().max(256),
    codeVerifier: z.string().max(256),
    redirectUri: z.string().max(2048),
  })
  .strict();
export type AppTokenBody = z.infer<typeof AppTokenBodySchema>;
export class AppTokenBodyDto extends createZodDto(AppTokenBodySchema, "AppTokenBody") {}
