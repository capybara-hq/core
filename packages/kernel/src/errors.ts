/**
 * API 错误码与对应的 HTTP 状态码。错误响应统一为 `{ error: { code, message, details? } }`：
 * `message` 为英文，界面文案以 `code` 为 key 走 i18n。后续任务往这里追加错误码。
 */
export const ERROR_CODES = {
  internal: 500,
  not_found: 404,
  validation_failed: 400,
  forbidden: 403,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  "account.login_taken": 409,
  "account.not_found": 404,
  "account.last_enterprise_admin": 409,
  "auth.account_disabled": 403,
  "auth.required": 401,
  "auth.token_expired": 401,
  "auth.session_revoked": 401,
  "auth.refresh_invalid": 401,
  "auth.refresh_race": 401,
  "auth.invalid_credentials": 401,
  "auth.csrf": 403,
  "auth.rate_limited": 429,
  "auth.session_required": 403,
  "token.not_found": 404,
  "org.not_found": 404,
  "org.creation_disabled": 403,
  "org.slug_taken": 409,
  "org.last_owner": 409,
  "org.owner_required": 403,
  "member.not_found": 404,
  "member.already_exists": 409,
  "member.anonymous_guest": 409,
  "invitation.invalid": 404,
  "invitation.expired": 410,
  "invitation.used": 409,
  "plugin.not_found": 404,
  "plugin.no_org_config": 400,
  "plugin.config_invalid": 400,
  "plugin.dependency_missing": 409,
  "plugin.has_dependents": 409,
  "plugin.not_enabled": 409,
  "directory.not_configured": 409,
  "setup.already_completed": 409,
  "setup.token_invalid": 403,
  "agent.not_found": 404,
  "agent.model_unavailable": 400,
  "conversation.not_found": 404,
  "conversation.output_not_found": 404,
  "run.not_active": 409,
  "app.not_found": 404,
  "app.slug_taken": 409,
  "app.connect_failed": 502,
  "app.tool_not_found": 404,
  "app.tool_not_pending": 409,
  "app.resources_disabled": 409,
  "approval.not_found": 404,
  "approval.already_decided": 409,
  "question.not_found": 404,
  "question.already_answered": 409,
  "tool_output.not_found": 404,
  "credential.missing": 409,
  "identity.taken": 409,
  "identity.not_found": 404,
  "identity.last_login_method": 409,
  "bind.invalid": 404,
  "channel.not_found": 404,
  "channel.verify_failed": 502,
  "ui.not_found": 404,
  "ui.render_failed": 502,
  "ui.action_failed": 502,
  "ui.invalid_view": 502,
  "ui.timeout": 504,
  "storage.unavailable": 503,
  "attachment.not_found": 404,
  "attachment.not_ready": 409,
  "attachment.too_large": 413,
  "attachment.type_not_allowed": 415,
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
