/**
 * API 错误码与对应的 HTTP 状态码。错误响应统一为 `{ error: { code, message, details? } }`：
 * `message` 为英文，界面文案以 `code` 为 key 走 i18n。后续任务往这里追加错误码。
 */
export const ERROR_CODES = {
  internal: 500,
  not_found: 404,
  validation_failed: 400,
  forbidden: 403,
  "account.login_taken": 409,
  "account.not_found": 404,
  "account.last_enterprise_admin": 409,
  "auth.account_disabled": 403,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** 业务代码抛出的 API 错误；由 HTTP 层的错误过滤器转成错误信封。 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown[],
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

/** 错误信封的 body。 */
export function errorBody(
  code: ErrorCode,
  message: string,
  details?: unknown[],
): { error: { code: ErrorCode; message: string; details?: unknown[] } } {
  return { error: { code, message, ...(details !== undefined && { details }) } };
}
