"use client";

import {
  Badge,
  Button,
  Checkbox,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AccountPatch,
  type AdminAccount,
  type AdminAccountsPage,
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
} from "../../../../lib/admin";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useServerState } from "../../../../lib/use-server-state";

/**
 * `/admin/accounts`：部署上的全部账号（企业管理员，ListPage）。新建账号；停用 / 启用；
 * 授予或撤销「企业管理员」。改动前一律二次确认（撤销最后一个企业管理员由内核拒绝，错误显示在确认框里）。
 */
/** 待确认的改动。 */
type Pending = { account: AdminAccount; action: "grant" | "revoke" | "disable" | "enable" };

const PATCH: Record<Pending["action"], AccountPatch> = {
  grant: { isEnterpriseAdmin: true },
  revoke: { isEnterpriseAdmin: false },
  disable: { status: "disabled" },
  enable: { status: "active" },
};

export default function AdminAccounts({ initial }: { initial: AdminAccountsPage }) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.accounts");
  const errorMessage = useErrorMessage();
  // The first page comes from the server; "load more" appends later pages in the browser.
  const [first, setFirst] = useServerState(initial);
  const [more, setMore] = useState<{ source: AdminAccountsPage; pages: AdminAccountsPage[] }>({
    source: initial,
    pages: [],
  });
  const pages = more.source === initial ? more.pages : [];
  const rows = [...first.accounts, ...pages.flatMap((p) => p.accounts)];
  const next = pages.length > 0 ? (pages[pages.length - 1] as AdminAccountsPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [creating, setCreating] = useState(false);

  const loadMore = (after: string) => {
    setLoadingMore(true);
    listAdminAccounts(after)
      .then((page) => setMore({ source: initial, pages: [...pages, page] }))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const replace = (a: AdminAccount) => {
    const swap = (rs: AdminAccount[]) => rs.map((r) => (r.id === a.id ? a : r));
    setFirst({ ...first, accounts: swap(first.accounts) });
    setMore({
      source: initial,
      pages: pages.map((p) => ({ ...p, accounts: swap(p.accounts) })),
    });
  };

  const columns: Column<AdminAccount>[] = [
    { key: "name", header: t("columns.name"), cell: (a) => a.displayName },
    { key: "email", header: t("columns.email"), tone: "muted", cell: (a) => a.email ?? "—" },
    {
      key: "status",
      header: t("columns.status"),
      cell: (a) =>
        a.status === "active" ? (
          <StatusMark status="success" label={t("status.active")} />
        ) : (
          <StatusMark status="cancelled" label={t("status.disabled")} />
        ),
    },
    {
      key: "role",
      header: t("columns.role"),
      cell: (a) => (a.isEnterpriseAdmin ? <Badge tone="accent">{t("enterpriseAdmin")}</Badge> : ""),
    },
  ];

  return (
    <ListPage
      header={{
        path: [...scope, { label: "accounts" }],
        title: t("title"),
        count: String(rows.length) + (next === null ? "" : "+"),
        actions: [{ label: t("new"), variant: "primary", onSelect: () => setCreating(true) }],
      }}
    >
      <Stack gap={12}>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          state="ready"
          empty={{ title: t("empty") }}
          isDisabled={(a) => a.status === "disabled"}
          rowMenu={(a) => {
            // The kernel refuses to revoke or disable the last active enterprise admin
            // (account.last_enterprise_admin): with the whole list loaded the page knows it and
            // offers neither, saying why; a partial list leaves it to the kernel's refusal.
            const activeAdmins = rows.filter((r) => r.isEnterpriseAdmin && r.status === "active");
            const last =
              next === null &&
              a.isEnterpriseAdmin &&
              a.status === "active" &&
              activeAdmins.length <= 1;
            if (last) return [{ label: t("lastAdmin"), disabled: true, onSelect: () => {} }];
            return [
              a.isEnterpriseAdmin
                ? {
                    label: t("menu.revoke"),
                    onSelect: () => setPending({ account: a, action: "revoke" }),
                  }
                : {
                    label: t("menu.grant"),
                    onSelect: () => setPending({ account: a, action: "grant" }),
                  },
              a.status === "active"
                ? {
                    label: t("menu.disable"),
                    danger: true,
                    onSelect: () => setPending({ account: a, action: "disable" }),
                  }
                : {
                    label: t("menu.enable"),
                    onSelect: () => setPending({ account: a, action: "enable" }),
                  },
            ];
          }}
        />
        {next !== null && (
          <Stack direction="row">
            <Button
              loading={loadingMore}
              onClick={() => {
                loadMore(next);
              }}
            >
              {t("loadMore")}
            </Button>
          </Stack>
        )}
      </Stack>
      {pending !== null && (
        <ConfirmDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(a) => {
            replace(a);
            setPending(null);
          }}
          errorMessage={errorMessage}
        />
      )}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setFirst({ ...first, accounts: [...first.accounts, a] });
            setCreating(false);
          }}
        />
      )}
    </ListPage>
  );
}

/** 停用 / 启用 / 授予 / 撤销企业管理员的二次确认。 */
function ConfirmDialog({
  pending,
  onClose,
  onDone,
  errorMessage,
}: {
  pending: Pending;
  onClose(): void;
  onDone(a: AdminAccount): void;
  errorMessage(e: unknown): string;
}) {
  const t = useTranslations("admin.accounts");
  const tc = useTranslations("common");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { account, action } = pending;
  const name = account.displayName;
  const danger = action === "revoke" || action === "disable";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { account: updated } = await updateAdminAccount(account.id, PATCH[action]);
      toast.success(t(`done.${action}`, { name }));
      onDone(updated);
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

/** 新建本地账号（可同时设为企业管理员）。 */
function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(a: AdminAccount): void;
}) {
  const t = useTranslations("admin.accounts.form");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [enterpriseAdmin, setEnterpriseAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = login.trim() !== "" && password !== "" && displayName.trim() !== "";

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await createAdminAccount({
        login: login.trim(),
        password,
        displayName: displayName.trim(),
        ...(email.trim() !== "" && { email: email.trim() }),
        enterpriseAdmin,
      });
      toast.success(t("created", { name: account.displayName }));
      onCreated(account);
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
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("login")} required>
          <Input value={login} autoComplete="off" onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label={t("password")} required help={t("passwordHelp")}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("displayName")} required>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={t("email")} optional>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Checkbox
          checked={enterpriseAdmin}
          onChange={setEnterpriseAdmin}
          label={t("enterpriseAdmin")}
        />
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
