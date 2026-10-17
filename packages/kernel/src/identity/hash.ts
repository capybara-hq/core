import { createHash } from "node:crypto";

/** 令牌的 SHA-256 十六进制摘要：会话刷新令牌、API 令牌、邀请令牌在库里只存这个。 */
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
