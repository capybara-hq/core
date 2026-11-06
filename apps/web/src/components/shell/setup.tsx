"use client";

import {
  Button,
  Card,
  type IconName,
  LinkButton,
  ObjectList,
  ObjectRow,
  type SetupStep,
  Stack,
  type Step,
  StepList,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext } from "react";
import { type OrgReadiness, setupReady } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import type { Me } from "../../lib/session";
import { setupRouteOf, under } from "../../lib/setup-routes";
import { navLevelOf } from "./nav";

export { setupReady };

/**
 * Whether the current org can run (web-order spec §3.8), from `GET /orgs/:id/readiness` as the
 * `(app)` layout read it: `setup` while the model provider or an agent is missing (with the answer),
 * else `ready`; `unknown` only outside the layout.
 */
export type Readiness =
  | { kind: "unknown" }
  | { kind: "ready" }
  | ({ kind: "setup" } & OrgReadiness);

export { setupRouteOf };

/**
 * The layout decision for pages: whether the setup frame is drawn, the org's readiness as the
 * layout read it, and a re-read (`router.refresh()`). Pages never read readiness themselves.
 */
export const SetupContext = createContext<{
  active: boolean;
  readiness: Readiness;
  recheck(): Promise<void>;
}>({ active: false, readiness: { kind: "unknown" }, recheck: async () => {} });

export const useSetup = () => useContext(SetupContext);

/** Who is looking at the checklist: what they may do decides each step's action. */
type SetupRole = "superAdmin" | "orgAdmin" | "member" | "guest";

function setupRoleOf(me: Me): SetupRole {
  if (me.account.isSuperAdmin) return "superAdmin";
  if (canUpdateOrg(me)) return "orgAdmin";
  return navLevelOf(me) === "member" ? "member" : "guest";
}

/**
 * The setup sidebar's steps (web-SSR spec §4), by what the viewer may do (cosmetic; the kernel
 * decides). The model is deployment-wide: a super admin configures it in the admin console,
 * everyone else waits (an org admin for a deployment admin). The agent: members and up create it
 * once a model exists, guests wait for an admin. Then the optional steps: org admins invite
 * members, connect a channel and install plugins; members connect their own accounts.
 */
export function useSetupSteps(me: Me, r: OrgReadiness): SetupStep[] {
  const t = useTranslations("setupLayout");
  const role = setupRoleOf(me);
  const hasModel = r.modelProvider === "ready";
  const canCreateAgent = navLevelOf(me) !== "guest";
  const model: SetupStep = hasModel
    ? {
        id: "model",
        label: t("steps.model"),
        state: "done",
        ...(role === "superAdmin" ? { href: "/admin/extensions" } : {}),
      }
    : role === "superAdmin"
      ? { id: "model", label: t("steps.model"), state: "todo", href: "/admin/extensions" }
      : {
          id: "model",
          label: t("steps.model"),
          state: "waiting",
          reason:
            role === "orgAdmin" ? t("model.needsDeploymentAdmin") : t("model.waitingForAdmin"),
        };
  const agent: SetupStep =
    r.agents > 0
      ? {
          id: "agent",
          label: t("steps.agent"),
          state: "done",
          ...(canCreateAgent ? { href: "/agents/new" } : {}),
        }
      : !canCreateAgent
        ? {
            id: "agent",
            label: t("steps.agent"),
            state: "waiting",
            reason: t("agent.waitingForAdmin"),
          }
        : hasModel
          ? { id: "agent", label: t("steps.agent"), state: "todo", href: "/agents/new" }
          : {
              id: "agent",
              label: t("steps.agent"),
              state: "waiting",
              reason: t("agent.needsModel"),
            };
  const later = (id: string, href: string): SetupStep => ({
    id,
    label: t(`steps.${id}` as "steps.model"),
    state: "todo",
    href,
    optional: true,
  });
  const optional = canUpdateOrg(me)
    ? [
        later("channels", "/channels/new"),
        later("members", "/settings/members"),
        later("catalog", "/plugins"),
      ]
    : navLevelOf(me) === "member"
      ? [later("connections", "/account/connections")]
      : [];
  return [model, agent, ...optional];
}

/** The setup sidebar's current item for a route: `home`, the step whose page it is, or none. */
export function activeStepOf(pathname: string, steps: SetupStep[]): string {
  if (setupRouteOf(pathname) !== "step") return "home";
  return steps.find((s) => s.href !== undefined && under(pathname, s.href))?.id ?? "";
}

/** The icon of each optional step's row on the setup home (the workspace's own icons). */
const LATER_ICON: Record<string, IconName> = {
  channels: "channel",
  members: "user",
  catalog: "catalog",
  connections: "link",
};

/**
 * The setup home (`/chat`, the workspace's home, while not ready): the same steps as the setup sidebar
 * ({@link useSetupSteps}: ids, labels, order, states). The required ones in the checklist card
 * (no head: "已完成 n / 2" is the page head's count, drawn by the app frame), each with a
 * description and one thing at the right:
 * the action this viewer may take, or why it waits; then "可以稍后再做" with the optional ones as
 * object rows (icon, label, one sentence). A viewer with nothing to do now is told why
 * (role-specific), with a refresh that re-reads readiness.
 */
export function SetupHome({
  me,
  readiness,
  onRefresh,
  refreshing = false,
}: {
  me: Me;
  readiness: OrgReadiness;
  onRefresh(): void;
  /** The refresh is waiting for the server. */
  refreshing?: boolean;
}) {
  const t = useTranslations();
  const all = useSetupSteps(me, readiness);
  const required = all.filter((s) => !s.optional);
  const optional = all.filter((s) => s.optional);
  const superAdmin = setupRoleOf(me) === "superAdmin";
  const description: Record<string, string> = {
    model: superAdmin ? t("chat.setup.model.description") : t("chat.setup.model.askAdmin"),
    agent: t("chat.setup.agent.description"),
  };
  const actionLabel: Record<string, string> = {
    model: t("chat.setup.model.action"),
    agent: t("chat.setup.agent.action"),
  };
  const actionOf = (s: SetupStep): ReactNode => {
    if (s.state === "done") return undefined;
    if (s.state === "todo" && s.href !== undefined) {
      const href = s.href;
      return (
        <LinkButton variant="primary" href={href}>
          {actionLabel[s.id]}
        </LinkButton>
      );
    }
    // Waiting: only the reason (who acts, or what comes first).
    return (
      <Text variant="small" tone="muted">
        {s.reason}
      </Text>
    );
  };
  const steps: Step[] = required.map((s) => {
    const action = actionOf(s);
    return {
      label: s.label,
      description: description[s.id] ?? "",
      done: s.state === "done",
      ...(action === undefined ? {} : { action }),
    };
  });
  // Nothing this viewer can do now: an org admin waits for a deployment admin's model, anyone else
  // for an org admin.
  const blocked = required.some((s) => s.state === "todo")
    ? null
    : required.some((s) => s.id === "model" && s.state === "waiting") && canUpdateOrg(me)
      ? "deployment"
      : "admin";
  return (
    <Stack gap={16}>
      <Card>
        <StepList steps={steps} inset="card" />
      </Card>
      {blocked === null ? null : (
        <Stack direction="row" gap={12} align="center">
          <Text tone="muted">
            {blocked === "deployment"
              ? t("setupLayout.waitingDeployment")
              : t("setupLayout.waiting")}
          </Text>
          <Button loading={refreshing} onClick={onRefresh}>
            {t("setupLayout.refresh")}
          </Button>
        </Stack>
      )}
      {optional.length > 0 ? (
        <Stack gap={8}>
          <Text variant="h2">{t("home.setup.later")}</Text>
          <ObjectList label={t("home.setup.later")}>
            {optional.map((s) => (
              <ObjectRow
                key={s.id}
                mark={{ icon: LATER_ICON[s.id] ?? "circle" }}
                name={s.label}
                {...(s.href !== undefined ? { href: s.href } : {})}
                description={t(`home.setup.laterHint.${s.id}` as "home.setup.laterHint.members")}
              />
            ))}
          </ObjectList>
        </Stack>
      ) : null}
    </Stack>
  );
}
