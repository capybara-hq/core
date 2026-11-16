import { formatDuration } from "@capybara-hq/design";
import { myRole, roleAtLeast } from "./members";
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
 * Where the row's 去配置模型服务 leads, or null when the reader can act on neither page: the super
 * admin's `/admin/models` (the platform's model services and their config), else the org admin's
 * `/settings/models` (the services on in the org, their org config, the org's models).
 */
export function configureModelsHref(me: RunRowViewer): string | null {
  if (me.account.isSuperAdmin) return "/admin/models";
  return roleAtLeast(myRole(me), "admin") ? "/settings/models" : null;
}

/**
 * Failures a model service's setup causes (credentials, a purpose without a model, a model gone or
 * not on in the org), fixed on the models pages.
 */
const MODEL_SETUP_ERRORS = new Set(["model.auth", "model.unconfigured", "run.model_unavailable"]);
export const isModelSetupError = (code: string): boolean => MODEL_SETUP_ERRORS.has(code);

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
