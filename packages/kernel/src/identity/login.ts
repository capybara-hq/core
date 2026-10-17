import { ApiError } from "../errors.js";

const LOGIN_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/;

/** 规范化登录名（NFKC、去空白、转小写）并校验格式；身份的外部 ID 就是它。 */
export function normalizeLogin(raw: string): string {
  const login = raw.normalize("NFKC").trim().toLowerCase();
  if (!LOGIN_RE.test(login)) {
    throw new ApiError(
      "validation_failed",
      "Login must be 3-64 characters: letters, digits, . _ @ + -",
      [{ path: "login", message: "invalid login format" }],
    );
  }
  return login;
}

/** 密码长度上限（防止 scrypt 被超长输入拖慢）。 */
export const MAX_PASSWORD_LENGTH = 256;

/** 密码长度 12–256。 */
export function validatePassword(p: string): void {
  if (p.length < 12 || p.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError("validation_failed", "Password must be 12-256 characters", [
      { path: "password", message: "length must be between 12 and 256" },
    ]);
  }
}
