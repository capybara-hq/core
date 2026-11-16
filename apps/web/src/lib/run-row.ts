import { formatDuration } from "@capybara-hq/design";
import { myRole, roleAtLeast } from "./members";
import { type ModelConfigCause, type ModelConfigViewer, modelConfigHref } from "./model-config";
import type { RunData } from "./timeline";

/** What the gates read of `GET /me` (the session's `me`). */
export interface RunRowViewer {
  account: { id: string; isSuperAdmin: boolean };
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}

/**
 * Whether the run row offers 查看轨迹: the kernel's rule (`TrajectoryService.canView`), an org admin
 * or owner, or the agent's owner who is at least a member; anyone else gets a 404 there. The UI
 * hides what the role cannot open; the kernel stays the authority.
 */
export function canViewTrajectory(me: RunRowViewer, agentOwnerId: string | undefined): boolean {
  const role = myRole(me);
  if (!roleAtLeast(role, "member")) return false;
  return (
    roleAtLeast(role, "admin") || (agentOwnerId !== undefined && agentOwnerId === me.account.id)
  );
}

/**
 * Failures a model service's setup causes, by where they are fixed ({@link modelConfigHref}): a
 * model gone or not on in the org (`not_enabled`), failed credentials (`credentials`: the org's own
 * copy or the platform's), a purpose without a model (`platform`).
 */
const MODEL_SETUP_ERRORS: Readonly<Record<string, ModelConfigCause>> = {
  "run.model_unavailable": "not_enabled",
  "model.auth": "credentials",
  "model.unconfigured": "platform",
};
export const isModelSetupError = (code: string): boolean => MODEL_SETUP_ERRORS[code] !== undefined;

/**
 * Where a failed run's "Configure model services" leads for the error `code`, or null (not a model
 * setup error, or a viewer who can act on neither page): the setup checklist's rule.
 */
export function configureModelsHref(v: ModelConfigViewer, code: string): string | null {
  const cause = MODEL_SETUP_ERRORS[code];
  return cause === undefined ? null : modelConfigHref(cause, v);
}

/** The parts after "运行": the model, the duration, the tokens (the unknown ones left out). */
export function runParts(
  run: Pick<RunData, "model" | "durationMs" | "tokens">,
  locale: string,
  tokens: (n: string) => string,
): string[] {
  return [
    ...(run.model ? [run.model.model] : []),
    ...(run.durationMs !== null
      ? [formatDuration(run.durationMs, locale === "zh" ? "zh" : "en")]
      : []),
    ...(run.tokens ? [tokens(run.tokens.total.toLocaleString(locale))] : []),
  ];
}
