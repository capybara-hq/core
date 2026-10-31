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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "../../i18n/navigation";
import { getReadiness, type OrgReadiness } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import type { Me } from "../../lib/session";
import { navLevelOf } from "./nav";

/** Whether a conversation can start: a loaded model provider and an agent the viewer can see. */
export function setupReady(r: OrgReadiness): boolean {
  return r.modelProvider === "ready" && r.agents > 0;
}

/**
 * Whether the current org can run (web-order spec §3.8), from `GET /orgs/:id/readiness`:
 * `unknown` until it answers, `setup` while the model provider or an agent is missing (with the
 * answer), else `ready`.
 */
export type Readiness =
  | { kind: "unknown" }
  | { kind: "ready" }
  | ({ kind: "setup" } & OrgReadiness);

const READY_KEY = (orgId: string) => `cap.ready.${orgId}`;
const noSubscribe = () => () => {};

/** An org seen ready in this tab (sessionStorage; storage errors mean "not known"). */
function storedReady(orgId: string): boolean {
  try {
    return sessionStorage.getItem(READY_KEY(orgId)) === "1";
  } catch {
    return false;
  }
}

function storeReady(orgId: string, ready: boolean): void {
  try {
    if (ready) sessionStorage.setItem(READY_KEY(orgId), "1");
    else sessionStorage.removeItem(READY_KEY(orgId));
  } catch {
    // Not remembered: the next load reads again before painting.
  }
}

/**
 * The readiness of the current org (`undefined` while /me loads, `null` without an org, which the
 * org chooser handles), from the cheap readiness endpoint (no vendor call).
 *
 * - An org seen ready in this tab (sessionStorage) is ready at once, re-validated in the
 *   background; the setup layout replaces the shell only if the re-read says so.
 * - `ready` is then kept until the org changes; while in setup every workspace navigation reads
 *   again (the step pages change it), keeping the setup state meanwhile so nothing flips. Admin
 *   console navigations never read.
 * - A failed read counts as ready: the shell's pages report their own errors.
 * - An org switch keeps a ready shell until the new org is read.
 *
 * `recheck()` reads again and resolves once the new state is set (ignored for a stale org).
 */
export function useReadiness(
  orgId: string | null | undefined,
  pathname: string,
): { state: Readiness; recheck(): Promise<void> } {
  const [held, setHeld] = useState<{ orgId: string | null; r: Readiness } | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const orgRef = useRef(orgId);
  orgRef.current = orgId;
  // The server render and the first hydration know nothing stored (the neutral state).
  const known = useSyncExternalStore(
    noSubscribe,
    () => (typeof orgId === "string" ? storedReady(orgId) : false),
    () => false,
  );
  const read = useCallback(async (org: string): Promise<Readiness> => {
    try {
      const r = await getReadiness(org);
      const ready = setupReady(r);
      storeReady(org, ready);
      return ready ? { kind: "ready" } : { kind: "setup", ...r };
    } catch {
      return { kind: "ready" };
    }
  }, []);
  // Admin console routes need no readiness: their navigations do not trigger a read.
  const trigger = setupRouteOf(pathname) === "outside" ? "outside" : pathname;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger only triggers a re-read
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
      if (live && orgRef.current === orgId) setHeld({ orgId, r });
    });
    return () => {
      live = false;
    };
  }, [orgId, trigger, read]);
  const recheck = useCallback(async () => {
    const org = orgRef.current;
    if (org === undefined || org === null) return;
    const r = await read(org);
    if (orgRef.current === org) setHeld({ orgId: org, r });
  }, [read]);
  const state: Readiness =
    orgId === undefined
      ? { kind: "unknown" }
      : held !== null && held.orgId === orgId
        ? held.r
        : known || held?.r.kind === "ready"
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

/**
 * The layout decision for pages (one read, shared): whether the setup layout is drawn, the org's
 * readiness as the app frame read it, and a re-read. Pages never read readiness themselves.
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
export function useSetupSteps(
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
 * The setup home (`/`, `/chat` while not ready): the checklist card ("开始之前 · 已完成 n / 3"),
 * then "可以稍后再做" with only what this viewer can act on (admins: invite members, channels,
 * plugins; members: their connections). A viewer with nothing to do is told why (role-specific),
 * with a refresh that re-reads readiness.
 */
export function SetupHome({
  me,
  readiness,
  onRefresh,
}: {
  me: Me;
  readiness: OrgReadiness;
  onRefresh(): void;
}) {
  const th = useTranslations("home.setup");
  const ts = useTranslations("setupLayout");
  const { steps, blocked } = useSetupSteps(me, readiness);
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
