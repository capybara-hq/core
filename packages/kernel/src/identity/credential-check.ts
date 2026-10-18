import type { ErrorCode } from "../errors.js";
import type { ApiTokenService } from "./api-tokens.js";
import type { UserPrincipal } from "./principal.js";
import type { SessionService } from "./sessions.js";

/** 复核凭据：仍然有效返回 null，否则返回应告知客户端的错误码。 */
export type CredentialCheck = () => Promise<ErrorCode | null>;

/**
 * 长连接（SSE）用的凭据复核：重新校验建立连接时使用的凭据，登出 / 吊销后连接不能继续收数据（R35）。
 * - Web 会话：按 sessionId 查会话行（未吊销、未过期、仍属该账号）；**不**重验 access token 的 exp，
 *   access token 到期但会话仍有效时连接照常保持（客户端靠刷新续期，已建立的流不受影响）。
 * - 个人令牌：用建立连接时的令牌明文重新 `authenticate`（吊销 / 过期 → 失效）。
 * 账号停用由调用方的可见性判定（账号须为 active）覆盖。
 */
export function credentialCheck(
  p: UserPrincipal,
  bearer: string | undefined,
  deps: {
    sessions: Pick<SessionService, "get">;
    tokens: Pick<ApiTokenService, "authenticate">;
  },
): CredentialCheck {
  if (p.via === "session") {
    const { sessionId } = p;
    const accountId = p.account.id;
    return async () => {
      const s = await deps.sessions.get(sessionId);
      return s && s.accountId === accountId ? null : "auth.session_revoked";
    };
  }
  const { tokenId } = p;
  return async () => {
    if (bearer === undefined) return "auth.required";
    const rec = await deps.tokens.authenticate(bearer);
    return rec && rec.id === tokenId ? null : "auth.required";
  };
}
