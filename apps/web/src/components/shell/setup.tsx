"use client";

import {
  Button,
  Card,
  ItemList,
  type ItemListRow,
  Stack,
  type Step,
  StepList,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { type Agent, listAgents, listModels, type ProviderModels } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import type { Me } from "../../lib/session";
import { navLevelOf } from "./nav";

/** Whether a conversation can start: a model to answer and an agent to talk to. */
export function setupReady(agents: Agent[], providers: ProviderModels[]): boolean {
  return agents.length > 0 && providers.some((p) => p.models.length > 0);
}

/**
 * Whether the current org can run (web-order spec §3.8): `unknown` until both reads answer,
 * `setup` while a model or an agent is missing (with what was read), else `ready`.
 */
export type Readiness =
  | { kind: "unknown" }
  | { kind: "ready" }
  | { kind: "setup"; agents: Agent[]; providers: ProviderModels[] };

/**
 * The readiness of the current org (`undefined` while /me loads, `null` without an org, which the
 * org chooser handles). Read once per org; `ready` is kept until the org changes; while in setup
 * every navigation reads again (the step pages change it), keeping the setup state meanwhile so
 * nothing flips. A failed read counts as ready: the shell's pages report their own errors. An org
 * switch keeps a ready shell until the new org is read.
 * `recheck()` reads again and resolves once the new state is set.
 */
export function useReadiness(
  orgId: string | null | undefined,
  pathname: string,
): { state: Readiness; recheck(): Promise<void> } {
  const [held, setHeld] = useState<{ orgId: string | null; r: Readiness } | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const read = useCallback(async (org: string) => {
    let r: Readiness;
    try {
      const [a, m] = await Promise.all([listAgents(org), listModels(org)]);
      r = setupReady(a.agents, m.providers)
        ? { kind: "ready" }
        : { kind: "setup", agents: a.agents, providers: m.providers };
    } catch {
      r = { kind: "ready" };
    }
    return r;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname only triggers a re-read
  useEffect(() => {
    if (orgId === undefined) return;
    if (orgId === null) {
      setHeld({ orgId, r: { kind: "ready" } });
      return;
    }
    const prev = heldRef.current;
    if (prev?.orgId === orgId && prev.r.kind === "ready") return;
    let live = true;
    void read(orgId).then((r) => {
      if (live) setHeld({ orgId, r });
    });
    return () => {
      live = false;
    };
  }, [orgId, pathname, read]);
  const recheck = useCallback(async () => {
    if (orgId === undefined || orgId === null) return;
    const r = await read(orgId);
    setHeld({ orgId, r });
  }, [orgId, read]);
  // After an org switch the shell stays while the new org is read (the switch already moves away
  // from org-bound pages); a first read shows the neutral state.
  const state: Readiness =
    orgId === undefined || held === null
      ? { kind: "unknown" }
      : held.orgId === orgId
        ? held.r
        : held.r.kind === "ready"
          ? { kind: "ready" }
          : { kind: "unknown" };
  return { state, recheck };
}

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Where a route stands while the org is not ready (web-order spec §3.8): `outside` keeps its own
 * frame (the admin console); `home` is the setup home (`/`, `/chat`); `step` renders inside the
 * setup frame with a back link (the pages a step needs, personal settings); anything else
 * `redirect`s to `/`.
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

/** The setup layout's state for pages: whether it is drawn, and a re-read of readiness. */
export const SetupContext = createContext<{ active: boolean; recheck(): Promise<void> }>({
  active: false,
  recheck: async () => {},
});

export const useSetup = () => useContext(SetupContext);

/** Who is looking at the checklist: what they may do decides each step's action. */
type SetupRole = "enterprise" | "orgAdmin" | "member" | "guest";

function setupRoleOf(me: Me): SetupRole {
  if (me.account.isEnterpriseAdmin) return "enterprise";
  if (canUpdateOrg(me)) return "orgAdmin";
  return navLevelOf(me) === "member" ? "member" : "guest";
}

/**
 * The one setup checklist (web-order spec §3.6, §3.8): the organization (always done), a model
 * and an agent, each with the action this viewer may take. The model: an enterprise admin
 * configures the provider extension in the admin console; an org admin sets the org's models
 * when the deployment has a provider, else is told a deployment admin must; members wait. The
 * agent: whoever may create agents (members and up) once a model exists; others wait.
 */
export function useSetupSteps(
  me: Me,
  agents: Agent[],
  providers: ProviderModels[],
): { steps: Step[]; actionable: boolean } {
  const t = useTranslations("chat.setup");
  const th = useTranslations("home.setup");
  const ts = useTranslations("setupLayout");
  const router = useRouter();
  const orgName = me.memberships.find((m) => m.orgId === me.currentOrgId)?.name ?? "";
  const role = setupRoleOf(me);
  const hasModel = providers.some((p) => p.models.length > 0);
  const hasAgent = agents.length > 0;
  const canCreateAgent = navLevelOf(me) !== "guest";
  const modelAction =
    role === "enterprise" ? (
      <Button variant="primary" onClick={() => router.push("/admin/extensions")}>
        {t("model.action")}
      </Button>
    ) : role === "orgAdmin" && providers.length > 0 ? (
      <Button variant="primary" onClick={() => router.push("/settings/models")}>
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
      description:
        role === "enterprise"
          ? t("model.description")
          : role === "orgAdmin" && providers.length > 0
            ? ts("model.orgDescription")
            : t("model.askAdmin"),
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
  // Something this viewer can do now: the model step's action, or creating the agent.
  const actionable =
    (!hasModel && modelAction !== null) || (hasModel && !hasAgent && canCreateAgent);
  return { steps, actionable };
}

/**
 * The setup home (`/`, `/chat` while not ready): the checklist card ("开始之前 · 已完成 n / 3"),
 * then "可以稍后再做" with only what this viewer can act on (admins: invite members, channels,
 * plugins; members: their connections). A viewer with nothing to do is told the org is being set
 * up, with a refresh that re-reads readiness.
 */
export function SetupHome({
  me,
  agents,
  providers,
  onRefresh,
}: {
  me: Me;
  agents: Agent[];
  providers: ProviderModels[];
  onRefresh(): void;
}) {
  const th = useTranslations("home.setup");
  const ts = useTranslations("setupLayout");
  const { steps, actionable } = useSetupSteps(me, agents, providers);
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
      {actionable ? null : (
        <Stack direction="row" gap={12} align="center">
          <Text tone="muted">{ts("waiting")}</Text>
          <Button onClick={onRefresh}>{ts("refresh")}</Button>
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
