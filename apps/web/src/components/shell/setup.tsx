"use client";

import {
  Button,
  Card,
  ItemList,
  type ItemListRow,
  type SetupStep,
  Stack,
  type Step,
  StepList,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import { useRouter } from "../../i18n/navigation";
import { type OrgReadiness, setupReady } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import type { Me } from "../../lib/session";
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

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Where a route stands while the org is not ready (web-order spec §3.8): `outside` keeps its own
 * frame (the admin console); `home` is the setup home (`/`, `/chat`); `step` renders inside the
 * setup frame (the pages a step needs, personal settings); anything else `redirect`s to `/`.
 */
export function setupRouteOf(pathname: string): "outside" | "home" | "step" | "redirect" {
  if (under(pathname, "/admin")) return "outside";
  if (pathname === "/" || pathname === "/chat") return "home";
  if (
    pathname === "/settings/models" ||
    pathname === "/settings/members" ||
    pathname === "/channels/new" ||
    under(pathname, "/agents") ||
    under(pathname, "/catalog") ||
    under(pathname, "/account")
  ) {
    // `/agents` itself is the list (not a step); `/agents/new` and `/agents/<id>` are.
    return pathname === "/agents" ? "redirect" : "step";
  }
  return "redirect";
}

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
type SetupRole = "enterprise" | "orgAdmin" | "member" | "guest";

function setupRoleOf(me: Me): SetupRole {
  if (me.account.isEnterpriseAdmin) return "enterprise";
  if (canUpdateOrg(me)) return "orgAdmin";
  return navLevelOf(me) === "member" ? "member" : "guest";
}

/**
 * The one setup checklist (web-order spec §3.6, §3.8): the organization (always done), the model
 * and an agent, each with the action this viewer may take. Models are deployment-wide: only an
 * enterprise admin can configure the provider (in the admin console); an org admin is told a
 * deployment admin must; members and guests wait. The agent: whoever may create agents (members
 * and up) once a model exists; others wait. `blocked` says why nothing can be done now.
 */
export function useSetupChecklist(
  me: Me,
  r: OrgReadiness,
): { steps: Step[]; blocked: "deployment" | "admin" | null } {
  const t = useTranslations("chat.setup");
  const th = useTranslations("home.setup");
  const ts = useTranslations("setupLayout");
  const router = useRouter();
  const orgName = me.memberships.find((m) => m.orgId === me.currentOrgId)?.name ?? "";
  const role = setupRoleOf(me);
  const hasModel = r.modelProvider === "ready";
  const hasAgent = r.agents > 0;
  const canCreateAgent = navLevelOf(me) !== "guest";
  const modelAction =
    role === "enterprise" ? (
      <Button variant="primary" onClick={() => router.push("/admin/extensions")}>
        {t("model.action")}
      </Button>
    ) : null;
  const modelWaiting =
    role === "orgAdmin" ? ts("model.needsDeploymentAdmin") : ts("model.waitingForAdmin");
  const agentAction = canCreateAgent ? (
    hasModel ? (
      <Button variant="primary" onClick={() => router.push("/agents/new")}>
        {t("agent.action")}
      </Button>
    ) : (
      <Stack direction="row" gap={8} align="center">
        <Button disabled>{t("agent.action")}</Button>
        <Text variant="small" tone="muted">
          {ts("agent.needsModel")}
        </Text>
      </Stack>
    )
  ) : null;
  const steps: Step[] = [
    { label: th("org"), description: orgName, done: true },
    {
      label: t("model.label"),
      description: role === "enterprise" ? t("model.description") : t("model.askAdmin"),
      done: hasModel,
      ...(hasModel
        ? {}
        : {
            action: modelAction ?? (
              <Text variant="small" tone="muted">
                {modelWaiting}
              </Text>
            ),
          }),
    },
    {
      label: t("agent.label"),
      description: t("agent.description"),
      done: hasAgent,
      ...(hasAgent
        ? {}
        : {
            action: agentAction ?? (
              <Text variant="small" tone="muted">
                {ts("agent.waitingForAdmin")}
              </Text>
            ),
          }),
    },
  ];
  // Nothing this viewer can do now: the model is missing and only a deployment admin can add it
  // (an org admin is blocked on them), or an agent is missing and someone else must create it.
  const actionable =
    (!hasModel && modelAction !== null) || (hasModel && !hasAgent && canCreateAgent);
  const blocked = actionable ? null : !hasModel && role === "orgAdmin" ? "deployment" : "admin";
  return { steps, blocked };
}

/**
 * The setup sidebar's steps (web-SSR spec §4), by what the viewer may do (cosmetic; the kernel
 * decides). The model is deployment-wide: an enterprise admin configures it in the admin console,
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
        ...(role === "enterprise" ? { href: "/admin/extensions" } : {}),
      }
    : role === "enterprise"
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
        later("catalog", "/catalog"),
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

/**
 * The setup home (`/`, `/chat` while not ready): the checklist card ("开始之前 · 已完成 n / 3"),
 * then "可以稍后再做" with only what this viewer can act on (admins: invite members, channels,
 * plugins; members: their connections). A viewer with nothing to do is told why (role-specific),
 * with a refresh that re-reads readiness.
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
  const th = useTranslations("home.setup");
  const ts = useTranslations("setupLayout");
  const { steps, blocked } = useSetupChecklist(me, readiness);
  const done = steps.filter((s) => s.done).length;
  const admin = canUpdateOrg(me);
  const later: ItemListRow[] = admin
    ? [
        {
          id: "members",
          title: th("inviteMembers"),
          meta: th("inviteMembersWhere"),
          href: "/settings/members",
        },
        {
          id: "channels",
          title: th("channels"),
          meta: th("channelsWhere"),
          href: "/channels/new",
        },
        { id: "catalog", title: th("catalog"), meta: th("catalogWhere"), href: "/catalog" },
      ]
    : navLevelOf(me) === "member"
      ? [
          {
            id: "connections",
            title: ts("later.connections"),
            meta: ts("later.connectionsWhere"),
            href: "/account/connections",
          },
        ]
      : [];
  return (
    <Stack gap={16}>
      <Card
        title={th("title")}
        actions={<Text tone="muted">{th("progress", { done, total: steps.length })}</Text>}
      >
        <StepList steps={steps} inset="card" />
      </Card>
      {blocked === null ? null : (
        <Stack direction="row" gap={12} align="center">
          <Text tone="muted">
            {blocked === "deployment" ? ts("waitingDeployment") : ts("waiting")}
          </Text>
          <Button loading={refreshing} onClick={onRefresh}>
            {ts("refresh")}
          </Button>
        </Stack>
      )}
      {later.length > 0 ? (
        <Card title={th("later")}>
          <ItemList label={th("later")} rows={later} />
        </Card>
      ) : null}
    </Stack>
  );
}
