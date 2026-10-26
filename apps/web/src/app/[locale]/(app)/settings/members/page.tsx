"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  type MenuItem,
  Select,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import {
  changeMemberRole,
  createInvitation,
  DEFAULT_INVITATION_HOURS,
  INVITABLE_ROLES,
  INVITATION_HOURS,
  type InvitableRole,
  type Invitation,
  inviteUrl,
  listInvitations,
  listMembers,
  type Member,
  myRole,
  ORG_ROLES,
  type OrgRole,
  removeMember,
  revokeInvitation,
  roleAtLeast,
  transferOwnership,
} from "../../../../../lib/members";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/members`：组织成员（ListPage）。成员起可看；管理员可以改角色、移出（二次确认）、
 * 邀请（生成一次性链接、撤销）；所有者还可以转让所有权。匿名访客行（渠道连接的匿名策略）角色控件禁用、
 * 没有移出与转让，带「匿名访客」Badge。界面只是隐藏，最终由内核判定。
 */
export default function MembersPage() {
  return <OrgGate>{(orgId) => <Members key={orgId} orgId={orgId} />}</OrgGate>;
}

type Pending = { member: Member; action: "remove" | "transfer" };

const date = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

function Members({ orgId }: { orgId: string }) {
  const t = useTranslations("members");
  const tn = useTranslations("connections.nav");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const role = myRole(me);
  const manage = roleAtLeast(role, "admin");
  const owner = role === "owner";
  const members = useLoad(() => listMembers(orgId), [orgId]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [inviting, setInviting] = useState(false);
  const rows = members.state.kind === "ready" ? members.state.data.members : [];

  const replace = (accountId: string, next: OrgRole) =>
    members.set({
      members: rows.map((m) => (m.account.id === accountId ? { ...m, role: next } : m)),
    });

  async function change(m: Member, next: OrgRole) {
    if (next === m.role) return;
    try {
      await changeMemberRole(orgId, m.account.id, next);
      replace(m.account.id, next);
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
      cell: (m) => date(m.joinedAt, locale),
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
    <ListPage
      header={{
        breadcrumb: [{ label: tn("organization"), href: "/settings/organization" }],
        title: t("title"),
        count: members.state.kind === "ready" ? String(rows.length) : undefined,
        actions: manage
          ? [{ label: t("invite"), variant: "primary", onSelect: () => setInviting(true) }]
          : [],
      }}
    >
      <Stack gap={24}>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(m) => m.account.id}
          rowLabel={(m) => m.account.displayName}
          state={members.state.kind}
          error={{
            code: members.state.kind === "error" ? members.state.code : "unknown",
            onRetry: members.reload,
          }}
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
            const { member, action } = pending;
            setPending(null);
            if (action === "remove") {
              members.set({ members: rows.filter((m) => m.account.id !== member.account.id) });
            } else {
              // 转让后自己降为 admin：重读会话（导航与权限）与成员列表
              members.reload();
            }
          }}
        />
      )}
    </ListPage>
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
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { member, action } = pending;
  const name = member.account.displayName;
  const danger = action === "remove";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === "remove") {
        await removeMember(orgId, member.account.id);
        toast.success(t("removed", { name }));
      } else {
        await transferOwnership(orgId, member.account.id);
        toast.success(t("transferred", { name }));
        await session.reload();
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
        <Text>{t(`confirm.${action}Hint`, { name })}</Text>
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
  const t = useTranslations("members");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const list = useLoad(() => listInvitations(orgId), [orgId]);
  // 最近的在前
  const rows = list.state.kind === "ready" ? [...list.state.data.invitations].reverse() : [];

  async function revoke(inv: Invitation) {
    try {
      await revokeInvitation(orgId, inv.id);
      toast.success(t("invitations.revoked"));
      list.reload();
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
      cell: (i) => date(i.createdAt, locale),
    },
    {
      key: "expires",
      header: t("invitations.columns.expires"),
      tone: "muted",
      cell: (i) => date(i.expiresAt, locale),
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
        rowLabel={(i) => `${t(`roles.${i.role}`)} · ${date(i.createdAt, locale)}`}
        state={list.state.kind}
        error={{
          code: list.state.kind === "error" ? list.state.code : "unknown",
          onRetry: list.reload,
        }}
        empty={{ title: t("invitations.empty") }}
        isDisabled={(i) => i.status !== "pending"}
        rowMenu={(i) =>
          i.status === "pending"
            ? [{ label: t("invitations.revoke"), danger: true, onSelect: () => void revoke(i) }]
            : []
        }
      />
      {inviting && (
        <InviteDialog orgId={orgId} onCreated={list.reload} onClose={() => setInviting(false)} />
      )}
    </Stack>
  );
}

/** 新建邀请：选角色与有效期 → 生成后显示可复制的链接（令牌只返回这一次）。 */
function InviteDialog({
  orgId,
  onCreated,
  onClose,
}: {
  orgId: string;
  onCreated(): void;
  onClose(): void;
}) {
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

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await createInvitation(orgId, { role, expiresInHours: hours });
      setLink(inviteUrl(window.location.origin, locale, token));
      onCreated();
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
