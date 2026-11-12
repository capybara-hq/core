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
  "lock.acquire_failed": 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  "account.login_taken": 409,
  "account.not_found": 404,
  "account.last_super_admin": 409,
  "account.initial_password_unavailable": 404,
  "account.create_needs_approval": 409,
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
  "auth.password_change_required": 403,
  "token.not_found": 404,
  "org.not_found": 404,
  "org.creation_disabled": 403,
  "org.slug_taken": 409,
  "org.last_owner": 409,
  "org.owner_required": 403,
  "org.sandbox_egress_not_allowed": 400,
  "org.sandbox_tier_not_allowed": 400,
  /** A deployment setting set in the startup config (file, Nacos or env): read-only in the admin console. */
  "deployment.setting_readonly": 409,
  /** Raising the platform's sandbox tiers through an API token or the Platform tool (only narrowing). */
  "deployment.sandbox_tier_not_allowed": 400,
  "member.not_found": 404,
  "member.already_exists": 409,
  "member.anonymous_guest": 409,
  "invitation.invalid": 404,
  "invitation.expired": 410,
  "invitation.used": 409,
  "extension.not_found": 404,
  /** The extension registers no tool of that name (org tool switches, layering spec A §7). */
  "extension.tool_not_found": 404,
  "extension.unavailable": 503,
  "extension.no_org_config": 400,
  "extension.config_invalid": 400,
  "extension.config_readonly": 409,
  "extension.field_not_overridable": 400,
  "extension.no_org_override": 404,
  "extension.needs_config": 409,
  "extension.dependency_missing": 409,
  "extension.has_dependents": 409,
  "extension.not_enabled": 409,
  "extension.package_invalid": 400,
  "extension.legacy_format": 422,
  "extension.no_extension": 400,
  "extension.package_too_large": 413,
  "extension.config_declared": 409,
  "extension.required": 409,
  "extension.name_conflict": 409,
  "extension.approval_stale": 409,
  "extension.not_pending": 409,
  "extension.package_unavailable": 409,
  "extension.package_not_found": 404,
  "extension.name_mismatch": 409,
  "extension.downgrade_unsupported": 409,
  "extension.not_disabled": 409,
  /**
   * Another enabled extension provides a single-provider extension point this one provides
   * (details `[{ extensionPoint, enabled: { name, displayName } }]`): disable it first.
   */
  "extension.single_provider_enabled": 409,
  /**
   * A required bootstrap plugin provides a single-provider extension point this one provides
   * (details as above, `required: true`): it cannot be disabled, so it cannot be replaced.
   */
  "extension.single_provider_required": 409,
  "packages.npm_failed": 502,
  "bootstrap.integrity_mismatch": 500,
  "bootstrap.download_failed": 502,
  "bootstrap.missing_file": 500,
  "catalog.invalid_manifest": 422,
  "catalog.legacy_format": 422,
  "catalog.no_extension": 409,
  "catalog.dependency_unresolved": 409,
  "catalog.dependency_disabled": 409,
  "catalog.dependency_cycle": 409,
  "catalog.version_exists": 409,
  "catalog.item_not_found": 404,
  /** An org-owned item its owner has not made shareable cannot be shown or associated (P3-16). */
  "catalog.not_shareable": 409,
  /** The owner org cannot be removed from its own item's list (P3-17). */
  "catalog.owner_required": 409,
  /**
   * Only the org's own rows can be made shareable: not an agent's skill, not a copy linked to a
   * platform item another owner has (P3-6).
   */
  "catalog.not_owned": 409,
  /** The item (or the version asked for) waits for the super admin's confirmation (P3-9). */
  "catalog.item_pending": 409,
  /** Deleting a platform plugin whose extension is still enabled on the deployment. */
  "catalog.extension_enabled": 409,
  /** A super admin confirmation raced the item's removal (P3-21). */
  "catalog.item_removed": 409,
  /** What deleting an org's own plugin does changed since its preview (P3-19). */
  "catalog.preview_stale": 409,
  "catalog.name_conflict": 409,
  /** A theme of an imported plugin fails its file or asset checks (themes spec §4, §5). */
  "theme.invalid": 400,
  /** A theme of an imported plugin fails the readability checks of its merged schemes (§5). */
  "theme.unreadable": 400,
  /**
   * A settings write names a theme that is not available where it is set (§7, §9): an org default
   * off in the org, a platform default that is not a platform theme with scope `all`, or a
   * person's pick on in none of their orgs; details `[{ theme }]`.
   */
  "theme.not_available": 400,
  /**
   * The change would take the platform default theme (`uiTheme`) away from an org: narrowing,
   * disabling, removing it or its plugin (§7); details `[{ theme, setting: "uiTheme" }]`.
   */
  "theme.platform_default": 409,
  /**
   * Another theme with the same id is already on in an org the change would turn this one on in
   * (§6, rule 10); details `[{ theme, orgId, themes, plugins }]`.
   */
  "theme.id_taken": 409,
  /**
   * A theme delivery URL names no stored theme version, or a file that version does not name (§8);
   * a removed theme's versions are still served.
   */
  "theme.not_found": 404,
  /**
   * An `extension.client` section whose extension manifest lacks `permissions.client: true`
   * (client extensions spec §5.4: client code is always declared and reviewed).
   */
  "client.undeclared": 400,
  /**
   * A client file's sha384 is not the integrity its plugin.json records (spec §9.1); details
   * `[{ file }]` (the manifest key).
   */
  "client.integrity_mismatch": 400,
  /**
   * The client section or a client file fails the import checks (spec §4.1, §9.1: a listed file
   * missing, a file not listed, a key that cannot be looked up exactly, a size limit, a stylesheet
   * not wrapped in `@layer extensions` or with `@import` / an absolute `url()`); details
   * `[{ file, reason }]`.
   */
  "client.invalid": 400,
  /**
   * The client section's `apiVersion` is newer than the deployment's `CLIENT_API_VERSION` (spec
   * §4.2): the web host could not run the bundle; details `[{ apiVersion, supported }]`.
   */
  "client.api_unsupported": 400,
  /**
   * A client file URL (`/api/v1/client/<plugin>/<build>/<file>`, spec §9.3) the caller may not
   * fetch: an unknown or old build, a file the build does not list (by its exact key), an extension
   * not running or not approved, not enabled in any live org the caller belongs to, or stopped by
   * the kill switch. One code for all, so nothing tells them apart.
   */
  "client.not_found": 404,
  "directory.not_configured": 409,
  "catalog.item_disabled": 403,
  "plugin.disabled": 409,
  "plugin.scope_locked": 409,
  "plugin.switch_stale": 409,
  "plugin.builtin": 409,
  "plugin.scope_stale": 409,
  "component.not_found": 404,
  "component.version_stale": 409,
  /** A platform component offered to the org but off there (one more connector from a template). */
  "component.off": 409,
  "catalog.approval_required": 403,
  "catalog.request_not_found": 404,
  /** No open org notice with that id for an admin of the org (inbox). */
  "inbox.notice_not_found": 404,
  "catalog.request_decided": 409,
  /** A pending request of the same kind for the same item or entry exists (spec §5.1 rule 5). */
  "catalog.request_pending": 409,
  /** The item is not in the state the request kind asks to change (already offered, on, ...). */
  "catalog.request_invalid": 409,
  /** The deployment setting `orgMarketplaceBrowse` is off: no marketplace requests. */
  "catalog.marketplace_browse_disabled": 409,
  "catalog.custom_disabled": 403,
  "catalog.not_deployed": 409,
  "catalog.icon_not_found": 404,
  "catalog.guide_not_found": 404,
  /** The check is not in the setup guide rendered for that mode and audience (setup guides v2 §10.3). */
  "catalog.check_not_found": 404,
  "marketplace.not_found": 404,
  "marketplace.entry_not_found": 404,
  "marketplace.fetch_failed": 502,
  "marketplace.invalid": 502,
  "marketplace.integrity_mismatch": 502,
  "marketplace.private_address": 422,
  "marketplace.redirect": 422,
  "marketplace.incompatible": 409,
  "marketplace.entry_deprecated": 409,
  "marketplace.package_mismatch": 409,
  "marketplace.builtin": 409,
  "marketplace.git_failed": 502,
  "marketplace.git_too_large": 422,
  "marketplace.git_unsupported_entry": 422,
  "marketplace.host_not_allowed": 403,
  "marketplace.path_unsupported": 422,
  "plugin.review_stale": 409,
  "plugin.name_taken": 409,
  "plugin.name_reserved": 409,
  "plugin.dependency_unavailable": 409,
  "plugin.extension_upload_pending": 501,
  "plugin.staging_not_found": 404,
  "plugin.install_failed": 502,
  "plugin.install_not_found": 404,
  "plugin.already_installed": 409,
  "plugin.install_in_progress": 409,
  "plugin.skill_conflict": 409,
  "plugin.upgrade_stale": 409,
  "plugin.upgrade_target_invalid": 409,
  "plugin.upgrade_failed": 502,
  /**
   * The platform's import and update imported the version but the update failed: the platform
   * stays on its version, the imported version is in the catalog (retry with the plain update).
   */
  "plugin.imported_not_updated": 409,
  "setup.already_completed": 409,
  "setup.token_invalid": 403,
  /** The admin overview's seven-day usage aggregate ran past its statement timeout (spec §5.5). */
  "admin.usage_unavailable": 503,
  /** No dead outbox row has this id (delivered, discarded, retried, or never dead). */
  "outbox.not_found": 404,
  "agent.not_found": 404,
  "agent.version_conflict": 409,
  /** The profile was changed since the client read it (`expectedUpdatedAt` is stale). */
  "agent.profile_conflict": 409,
  "agent.model_unavailable": 400,
  /** A save gave `instructionFiles` and an `instructions` that is not their join. */
  "agent.instructions_mismatch": 400,
  /** `subagents` of an agent definition is refused (details: `{ reason, path, value? }`). */
  "agent.subagents_invalid": 400,
  /** Creating from a template with a visibility other than `private` without `agents.manage`. */
  "agent.visibility_forbidden": 403,
  /** Creating from a template: the template or the org changed since the preview (P4-3). */
  "agent.template_preview_stale": 409,
  /** The agent has no pending connector with that key (ruling P4-6). */
  "agent.pending_connector_not_found": 404,
  /**
   * The connector does not fit the pending entry (ruling P4-T6-1; details `[{ reason }]`:
   * `template` another or no connector template, `protocol` another kind, `tools` none of the
   * entry's tools, `not_synced` no tool snapshot yet: an OAuth connector to authorize first).
   */
  "agent.pending_connector_mismatch": 400,
  /** Requesting connector setup for an agent with no pending connectors (ruling P4-T6-7). */
  "agent.no_pending_connectors": 409,
  /**
   * An org template's bare name is a type the org can already use (spec §5 rule 10, ruling
   * P4-9; details `[{ owner, templateId }]`, `owner` as `plugin.name_taken`'s).
   */
  "agent_template.name_taken": 409,
  /** An org template was saved since the editor read it (`expectedVersion` is stale, P4-12). */
  "agent_template.version_conflict": 409,
  "conversation.not_found": 404,
  "conversation.output_not_found": 404,
  "conversation.artifact_not_found": 404,
  "conversation.artifact_not_previewable": 400,
  /** A file output whose stored object is gone (UI refresh B, decision 8). */
  "conversation.artifact_removed": 410,
  /** The conversation already holds `QUEUE_MAX_ITEMS` queued messages (UI refresh B). */
  "conversation.queue_full": 409,
  "conversation.queue_item_not_found": 404,
  /** A sub-agent's conversation takes no messages from people (sub-agents spec §6.1). */
  "conversation.read_only": 409,
  "run.not_active": 409,
  /** A run that is not one of the conversation's (the live draft route, spec 2026-11-07 §3.2). */
  "run.not_found": 404,
  /** A background task that is not in this conversation (or its sub-agents), or does not exist. */
  "background_task.not_found": 404,
  /** The task's output cannot be read now (its sandbox is not running and no finish recorded it). */
  "background_task.output_unavailable": 409,
  "connector.not_found": 404,
  "connector.slug_taken": 409,
  /** The connector template's setup guide moved on since the person was shown it (guide-ack). */
  "connector.guide_changed": 409,
  "connector.kind_unavailable": 409,
  "connector.connect_failed": 502,
  "connector.tool_not_found": 404,
  "connector.tool_not_pending": 409,
  "connector.resources_disabled": 409,
  /** Per-member tool policies on a connector with one org credential (decision 2026-11-09). */
  "connector.not_personal": 409,
  "approval.not_found": 404,
  "approval.already_decided": 409,
  "approval.scope_not_allowed": 409,
  "approval.not_yours": 403,
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
  "channel.webhook_not_found": 404,
  "channel.webhook_unavailable": 409,
  "channel.webhook_retry": 503,
  "channel.guide_changed": 409,
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
  "attachment.too_many_pending": 429,
  "sandbox.unavailable": 503,
  "sandbox.busy": 409,
  /** A cloud sandbox provider refused the device's tier (its config refuses open egress). */
  "sandbox.tier_refused": 409,
  /** A cloud sandbox provider failed to create a device's sandbox for another reason. */
  "sandbox.create_failed": 502,
  /** A sandbox file path the kernel reads is not absolute or not under the sandbox roots. */
  "sandbox.file_invalid_path": 422,
  /** No file at the sandbox path the kernel reads. */
  "sandbox.file_not_found": 422,
  /** The sandbox path the kernel reads is a directory, not one file. */
  "sandbox.file_is_directory": 422,
  /** The sandbox file the kernel reads is over the caller's size limit. */
  "sandbox.file_too_large": 422,
  /** The device is missing, deleted, or not the caller's (never 403, so ids cannot be probed). */
  "device.not_found": 404,
  /** The cloud device's file system is gone at the provider; reset its files to start empty. */
  "device.files_lost": 409,
  /** The caller may see the device but not use it (shared devices, later phases). */
  "device.forbidden": 403,
  /** The device's provider is not the deployment's current one, or there is none. */
  "device.unavailable": 503,
  /** The person already has a live device with this name (case-insensitive). */
  "device.name_taken": 409,
  /** The person already has `devices.maxPersonal` live personal devices. */
  "device.limit_reached": 409,
  /**
   * A local device's files are on its machine: they cannot be reset from the platform; run
   * `capybara-device logout`, then `capybara-device login` into the device, on the machine
   * (ruling R24).
   */
  "device.files_on_device": 409,
  /** The local device's machine is not connected now (no replica holds its lease). */
  "device.offline": 503,
  /** The local device's machine runs a `capybara-device` too old for this kernel; update it. */
  "device.program_outdated": 426,
  /**
   * The device's machine refused a network policy change (its local `remoteGrants` is `off`, it
   * runs in Docker mode, or a host is invalid); the message says how to allow it on the machine.
   */
  "device.policy_refused": 409,
  /** The device cannot change its network policy from the platform (cloud, or an older program). */
  "device.policy_unsupported": 409,
  /**
   * The device runs commands without a sandbox (its owner set it locally), which the org or the
   * platform does not allow, or a scheduled run without the task's `tier:open` grant uses it
   * (sandbox dev tiers spec §4.3, §11.4); checked at each command.
   */
  "device.unsandboxed_not_allowed": 403,
  /**
   * A scheduled run uses a cloud device whose sandbox tier is open without the task's `tier:open`
   * grant (sandbox dev tiers spec §11.4).
   */
  "device.tier_not_granted": 403,
  /** A device's sandbox tier above the org's or the platform's highest (sandbox dev tiers §4.1). */
  "device.tier_not_allowed": 400,
  /** A local device's tier is kept on its machine (`policy` op or the local CLI), not the row. */
  "device.tier_on_device": 409,
  /** Device sign-in (RFC 8628 style): the person has not approved the code yet; keep polling. */
  "device_sign_in.authorization_pending": 400,
  /** Device sign-in: the program polls faster than the interval; add 5 seconds and keep polling. */
  "device_sign_in.slow_down": 400,
  /** Device sign-in: the code expired before it was approved; start over. */
  "device_sign_in.expired": 400,
  /** Device sign-in: the person denied the code. */
  "device_sign_in.denied": 400,
  /** Device sign-in: no pending code matches the one given. */
  "device_sign_in.code_invalid": 404,
  /** Device sign-in: the confirmation could not hand the credential to the program; start over. */
  "device_sign_in.unavailable": 503,
  /** The machine credential is unknown or revoked. */
  "device.credential_invalid": 401,
  /** The scheduled task is missing, deleted, in another org or not the caller's to see. */
  "schedule.not_found": 404,
  /** Not a 5-field cron expression (no seconds field). */
  "schedule.invalid_cron": 400,
  /** Not an IANA time zone. */
  "schedule.invalid_time_zone": 400,
  /** A `once` time that is not a local date-time `YYYY-MM-DDTHH:mm[:ss]`. */
  "schedule.invalid_once_time": 400,
  /** A `once` time that is not in the future. */
  "schedule.once_in_past": 400,
  /** Two fire times closer than the org's `minIntervalMinutes`. */
  "schedule.interval_too_short": 400,
  /** The creator or the org has as many active and paused tasks as the org allows. */
  "schedule.limit_reached": 409,
  /** The org turned scheduled tasks off. */
  "schedule.disabled": 409,
  /** Where the task runs is inconsistent or not the creator's to use (conversation, chat, device). */
  "schedule.target_invalid": 400,
  /** A tool the creator cannot pre-approve for the task (spec §7). */
  "schedule.grant_not_allowed": 400,
  /** An org admin may pause, resume and delete another person's task, never edit it. */
  "schedule.forbidden": 403,
  "skill.not_found": 404,
  /** Also a skill neither the model nor a person could use (phase D: both invocation flags off). */
  "skill.invalid_package": 400,
  /** An agent already has `AGENT_SKILLS_MAX` own skills. */
  "skill.agent_cap": 409,
  /** Sharing this agent skill with the org is already waiting for an org admin. */
  "skill.share_pending": 409,
  /** Another conversation's proposed version of this shared skill is waiting for an org admin. */
  "skill.proposal_pending_elsewhere": 409,
  /** A sub-agent conversation tried to register a skill on its agent (only the root registers). */
  "skill.subagent_register": 403,
  /**
   * A person invoked a skill (`/name`, phase D) that is not one of the agent's effective skills
   * (`details: [{ reason: "not_found" }]`) or is hidden from the menu (`not_user_invocable`).
   */
  "skill.not_invocable": 400,
  /**
   * Uploading or sharing a skill: an org-level skill with this name already exists in the org
   * (P3-24, F18).
   */
  "skill.name_exists": 409,
  "skill_change.not_found": 404,
  "skill_change.already_decided": 409,
  "trajectory.not_found": 404,
  "eval.run_not_finished": 409,
  "eval.case_too_large": 413,
  "eval.call_not_found": 404,
  "eval.set_not_found": 404,
  "eval.case_not_found": 404,
  "eval.case_exists": 409,
  "eval.too_many_cases": 409,
  "eval.agent_mismatch": 409,
  "eval.run_not_found": 404,
  "eval.token_cap_invalid": 400,
  "eval.run_finished": 409,
  "eval.nothing_to_replay": 409,
  "eval.candidate_invalid": 400,
  "model.unconfigured": 409,
  "model.purpose_unknown": 404,
  "model.provider_not_found": 404,
  /** An extension's `ctx.models.embed` call was denied by a `model.request` policy hook. */
  "model.hook_denied": 403,
  "eval.result_not_found": 404,
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
