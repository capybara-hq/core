"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  DateTime,
  Dialog,
  Field,
  formatDateTime,
  Input,
  type MenuItem,
  Select,
  SettingsPage,
  Stack,
  StatusMark,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import {
  changeMemberRole,
  createInvitation,
  DEFAULT_INVITATION_HOURS,
  INVITABLE_ROLES,
  INVITATION_HOURS,
  type InvitableRole,
  type Invitation,
  inviteUrl,
  type Member,
  myRole,
  ORG_ROLES,
  type OrgRole,
  removeMember,
  revokeInvitation,
  roleAtLeast,
  transferOwnership,
} from "../../../../lib/members";
import { retryOnMountOf } from "../../../../lib/query/client";
import { keys } from "../../../../lib/query/keys";
import { membersQuery } from "../../../../lib/query/members";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { invitationsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

type Pending = { member: Member; action: "remove" | "transfer" };

/**
 * `/settings/members`: the org's members (SettingsPage, group 组织, with the settings sub-nav).
 * Members and up can read it; admins change roles, remove members (confirmed) and invite (a
 * one-time link, revocable); owners also transfer ownership. Anonymous visitor rows (a channel
 * connection's anonymous policy) have a disabled role control, no remove or transfer, and the
 * 「匿名访客」 badge. The UI only hides actions; the kernel decides.
 * From the query cache (the layout prefetched it on a first load): the members and, for admins,
 * the invitations (a section: a failure draws the invitation table's error state, with a retry).
 * A change invalidates what it changes; a transfer also reads the session again (my role).
 */
export default function MembersView() {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Members orgId={ws.orgId} />;
}

function Members({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const nav = useOrgSettingsNav();
  const t = useTranslations("members");
  const tr = useTranslations("roles");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const sessionRole = myRole(me);
  // After a transfer this account is an admin, but the session may say owner until it is read
  // again: act as an admin meanwhile (no owner-only actions).
  const [transferredAs, setTransferredAs] = useState<OrgRole>();
  const role: OrgRole | undefined =
    transferredAs !== undefined && sessionRole === transferredAs ? "admin" : sessionRole;
  const manage = roleAtLeast(role, "admin");
  const owner = role === "owner";
  const read = usePageQuery(membersQuery(orgId));
  const [pending, setPending] = useState<Pending | null>(null);
  const [inviting, setInviting] = useState(false);
  const changeRole = useAppMutation({
    fn: (v: { accountId: string; role: OrgRole }) => changeMemberRole(orgId, v.accountId, v.role),
    invalidates: () => [keys.org(orgId).members()],
  });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const rows = read.kind === "ready" ? read.data.members : [];
  const header = {
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "members" }],
    title: t("title"),
    ...(read.kind === "ready" ? { count: String(rows.length) } : {}),
    // Members read the list; managing it is for admins (R3: say why it is read-only)
    ...(manage || role === undefined
      ? {}
      : { description: tr("readOnly", { role: t(`roles.${role}`) }) }),
    actions: manage
      ? [{ label: t("invite"), variant: "primary" as const, onSelect: () => setInviting(true) }]
      : [],
  };

  async function change(m: Member, next: OrgRole) {
    if (next === m.role) return;
    try {
      await changeRole.mutateAsync({ accountId: m.account.id, role: next });
      toast.success(t("roleChanged", { name: m.account.displayName, role: t(`roles.${next}`) }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  /** 能否改这一行的角色：管理员起；不能改匿名访客、自己，改动所有者须是所有者。 */
  const editable = (m: Member) =>
    manage && !m.anonymous && m.account.id !== me.account.id && (owner || m.role !== "owner");

  const columns: Column<Member>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (m) => (
        <Stack direction="row" gap={8}>
          <Text>
            {m.account.id === me.account.id
              ? `${m.account.displayName} (${t("you")})`
              : m.account.displayName}
          </Text>
          {m.anonymous && <Badge>{t("anonymous")}</Badge>}
        </Stack>
      ),
    },
    {
      key: "email",
      header: t("columns.email"),
      tone: "muted",
      cell: (m) => m.account.email ?? "—",
    },
    {
      key: "role",
      header: t("columns.role"),
      cell: (m) =>
        manage ? (
          <Select
            aria-label={t("roleOf", { name: m.account.displayName })}
            value={m.role}
            disabled={!editable(m)}
            onChange={(e) => void change(m, e.target.value as OrgRole)}
            // 授予 owner 只有所有者能做；所有者行总要能显示自己的角色
            options={ORG_ROLES.filter((r) => r !== "owner" || owner || m.role === "owner").map(
              (r) => ({ value: r, label: t(`roles.${r}`) }),
            )}
          />
        ) : (
          t(`roles.${m.role}`)
        ),
    },
    {
      key: "joined",
      header: t("columns.joined"),
      tone: "muted",
      cell: (m) => <DateTime value={m.joinedAt} />,
    },
  ];

  const menu = (m: Member): MenuItem[] => {
    if (m.anonymous || m.account.id === me.account.id) return [];
    return [
      ...(owner && m.role !== "owner"
        ? [
            {
              label: t("menu.transfer"),
              onSelect: () => setPending({ member: m, action: "transfer" }),
            },
          ]
        : []),
      ...(owner || m.role !== "owner"
        ? [
            {
              label: t("menu.remove"),
              danger: true,
              onSelect: () => setPending({ member: m, action: "remove" }),
            },
          ]
        : []),
    ];
  };

  return (
    <SettingsPage nav={nav} activeNav="members" header={header}>
      <Stack gap={24}>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(m) => m.account.id}
          rowLabel={(m) => m.account.displayName}
          state={read.kind === "ready" ? "ready" : "loading"}
          empty={{ title: t("empty") }}
          {...(manage ? { rowMenu: menu } : {})}
        />
        {manage && <Invitations orgId={orgId} inviting={inviting} setInviting={setInviting} />}
      </Stack>
      {pending !== null && (
        <ConfirmDialog
          orgId={orgId}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            // After a transfer this account is an admin: shown at once (the session is read again)
            if (pending.action === "transfer") setTransferredAs(sessionRole);
            setPending(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

/** 移出 / 转让所有权的二次确认；内核错误（如最后一个所有者）显示在确认框里。 */
function ConfirmDialog({
  orgId,
  pending,
  onClose,
  onDone,
}: {
  orgId: string;
  pending: Pending;
  onClose(): void;
  onDone(): void;
}) {
  const t = useTranslations("members");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { member, action } = pending;
  const qc = useQueryClient();
  const remove = useAppMutation({
    fn: (accountId: string) => removeMember(orgId, accountId),
    invalidates: () => [keys.org(orgId).members()],
  });
  // A transfer changes my role too: the session (`/me`) is read again.
  const transfer = useAppMutation({
    fn: (accountId: string) => transferOwnership(orgId, accountId),
    invalidates: () => [keys.org(orgId).members()],
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.account("self").me() }),
  });
  const name = member.account.displayName;
  const danger = action === "remove";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === "remove") {
        await remove.mutateAsync(member.account.id);
        toast.success(t("removed", { name }));
      } else {
        await transfer.mutateAsync(member.account.id);
        toast.success(t("transferred", { name }));
      }
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(`confirm.${action}Title`, { name })}
      danger={danger}
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant={danger ? "danger-solid" : "primary"}
            loading={busy}
            onClick={() => void confirm()}
          >
            {t(`confirm.${action}`)}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t(`confirm.${action}Hint`, { name })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/** 邀请列表（管理员）：状态、过期时间；待接受的可以撤销。新建邀请的对话框也在这里。 */
function Invitations({
  orgId,
  inviting,
  setInviting,
}: {
  orgId: string;
  inviting: boolean;
  setInviting(v: boolean): void;
}) {
  const timeZone = useTimeZone();
  const t = useTranslations("members");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const invitationsQ = invitationsQuery(orgId);
  const read = useQuery({ ...invitationsQ, retryOnMount: retryOnMountOf(invitationsQ.queryKey) });
  // 最近的在前
  const rows = read.data === undefined ? [] : [...read.data.invitations].reverse();
  const revokeOne = useAppMutation({
    fn: (id: string) => revokeInvitation(orgId, id),
    invalidates: () => [keys.org(orgId).invitations()],
  });

  async function revoke(inv: Invitation) {
    try {
      await revokeOne.mutateAsync(inv.id);
      toast.success(t("invitations.revoked"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const columns: Column<Invitation>[] = [
    { key: "role", header: t("invitations.columns.role"), cell: (i) => t(`roles.${i.role}`) },
    {
      key: "status",
      header: t("invitations.columns.status"),
      cell: (i) => (
        <StatusMark
          status={
            i.status === "pending" ? "waiting" : i.status === "accepted" ? "success" : "cancelled"
          }
          label={t(`invitations.status.${i.status}`)}
        />
      ),
    },
    {
      key: "created",
      header: t("invitations.columns.created"),
      tone: "muted",
      cell: (i) => <DateTime value={i.createdAt} />,
    },
    {
      key: "expires",
      header: t("invitations.columns.expires"),
      tone: "muted",
      cell: (i) => <DateTime value={i.expiresAt} />,
    },
  ];

  return (
    <Stack gap={8}>
      <Text variant="h2" as="h2">
        {t("invitations.title")}
      </Text>
      <DataTable
        label={t("invitations.title")}
        columns={columns}
        rows={rows}
        rowKey={(i) => i.id}
        rowLabel={(i) =>
          `${t(`roles.${i.role}`)} · ${formatDateTime(i.createdAt, "full", timeZone)}`
        }
        state={read.data !== undefined ? "ready" : read.error ? "error" : "loading"}
        error={{ code: read.error?.code ?? "unknown", onRetry: () => void read.refetch() }}
        empty={{ title: t("invitations.empty") }}
        isDisabled={(i) => i.status !== "pending"}
        rowMenu={(i) =>
          i.status === "pending"
            ? [{ label: t("invitations.revoke"), danger: true, onSelect: () => void revoke(i) }]
            : []
        }
      />
      {inviting && <InviteDialog orgId={orgId} onClose={() => setInviting(false)} />}
    </Stack>
  );
}

/** 新建邀请：选角色与有效期 → 生成后显示可复制的链接（令牌只返回这一次）。 */
function InviteDialog({ orgId, onClose }: { orgId: string; onClose(): void }) {
  const t = useTranslations("members");
  const tc = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const actor = myRole(me);
  const [role, setRole] = useState<InvitableRole>("member");
  const [hours, setHours] = useState<number>(DEFAULT_INVITATION_HOURS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invite = useAppMutation({
    fn: (v: { role: InvitableRole; expiresInHours: number }) => createInvitation(orgId, v),
    invalidates: () => [keys.org(orgId).invitations()],
  });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await invite.mutateAsync({ role, expiresInHours: hours });
      setLink(inviteUrl(window.location.origin, locale, token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("inviteDialog.copied"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("inviteDialog.title")}
      footer={
        link === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              {t("inviteDialog.create")}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t("inviteDialog.done")}
          </Button>
        )
      }
    >
      {link === null ? (
        <Stack gap={12}>
          <Field label={t("inviteDialog.role")} help={t("inviteDialog.roleHelp")}>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as InvitableRole)}
              // 不能邀请比自己高的角色（内核同样拒绝）
              options={INVITABLE_ROLES.filter((r) => roleAtLeast(actor, r)).map((r) => ({
                value: r,
                label: t(`roles.${r}`),
              }))}
            />
          </Field>
          <Field label={t("inviteDialog.expires")}>
            <Select
              value={String(hours)}
              onChange={(e) => setHours(Number(e.target.value))}
              options={INVITATION_HOURS.map((h) => ({
                value: String(h),
                label: t(`inviteDialog.hours.${h}`),
              }))}
            />
          </Field>
          {error !== null && <FormError message={error} />}
        </Stack>
      ) : (
        <Stack gap={8}>
          <Field label={t("inviteDialog.link")} help={t("inviteDialog.linkHelp")}>
            <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          </Field>
          <Stack direction="row">
            <Button onClick={() => void copy(link)}>{t("inviteDialog.copy")}</Button>
          </Stack>
        </Stack>
      )}
    </Dialog>
  );
}
