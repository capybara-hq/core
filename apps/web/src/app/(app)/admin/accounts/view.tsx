"use client";

import {
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
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AccountPatch,
  type AdminAccount,
  type AdminAccountsPage,
  createAdminAccount,
  updateAdminAccount,
} from "../../../../lib/admin";
import { adminAccountsQuery } from "../../../../lib/query/admin";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/accounts`：部署上的全部账号（企业管理员，ListPage）。新建账号；停用 / 启用；
 * 授予或撤销「企业管理员」。改动前一律二次确认（撤销最后一个企业管理员由内核拒绝，错误显示在确认框里）。
 * The first page comes from the query cache (the layout prefetched it on a first load); "Load
 * more" reads later pages through the cache; a change writes the answered account into them.
 */
/** 待确认的改动。 */
type Pending = { account: AdminAccount; action: "grant" | "revoke" | "disable" | "enable" };

const PATCH: Record<Pending["action"], AccountPatch> = {
  grant: { isEnterpriseAdmin: true },
  revoke: { isEnterpriseAdmin: false },
  disable: { status: "disabled" },
  enable: { status: "active" },
};

export default function AdminAccountsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAccounts />;
}

function AdminAccounts() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.accounts");
  const read = usePageQuery(adminAccountsQuery());
  const header = { path: [...scope, { label: "accounts" }], title: t("title") };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <ListPage
        // The "new account" button's slot (it opens a dialog onto the loaded list).
        header={{ path: header.path, title: header.title, loading: { actions: 1 } }}
        loading={{ table: { label: t("title"), columns: accountColumns(t) } }}
      />
    );
  }
  return <Accounts header={header} first={read.data} />;
}

type T = ReturnType<typeof useTranslations<"admin.accounts">>;

/** The table's columns (the loading table draws the same header). */
const accountColumns = (t: T): Column<AdminAccount>[] => [
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
    cell: (a) => (a.isEnterpriseAdmin ? t("enterpriseAdmin") : ""),
  },
];

function Accounts({
  header,
  first,
}: {
  header: { path: { label: string; href?: string }[]; title: string };
  first: AdminAccountsPage;
}) {
  const t = useTranslations("admin.accounts");
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  // Later pages belong to the first page they continue (a newer first page starts over).
  const [more, setMore] = useState<{ source: AdminAccountsPage; pages: AdminAccountsPage[] }>({
    source: first,
    pages: [],
  });
  const pages = more.source === first ? more.pages : [];
  const rows = [...first.accounts, ...pages.flatMap((p) => p.accounts)];
  const next = pages.length > 0 ? (pages[pages.length - 1] as AdminAccountsPage).next : first.next;
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [creating, setCreating] = useState(false);
  const firstKey = adminAccountsQuery().queryKey;

  const loadMore = (after: string) => {
    setLoadingMore(true);
    qc.fetchQuery(adminAccountsQuery(after))
      .then((page) => setMore({ source: first, pages: [...pages, page] }))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  // The answer is the account as it is now: it replaces that row in the cached first page and in
  // the later pages read so far.
  const replace = (a: AdminAccount) => {
    const swap = (p: AdminAccountsPage) => ({
      ...p,
      accounts: p.accounts.map((r) => (r.id === a.id ? a : r)),
    });
    const nextFirst = swap(first);
    qc.setQueryData<AdminAccountsPage>(firstKey, nextFirst);
    setMore({ source: nextFirst, pages: pages.map(swap) });
  };

  const columns = accountColumns(t);
  return (
    <ListPage
      header={{
        path: header.path,
        title: header.title,
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
            // offers neither, so the row has no menu; a partial list leaves it to the kernel.
            const activeAdmins = rows.filter((r) => r.isEnterpriseAdmin && r.status === "active");
            const last =
              next === null &&
              a.isEnterpriseAdmin &&
              a.status === "active" &&
              activeAdmins.length <= 1;
            if (last) return [];
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
            // The answer is the new account: it joins the cached first page.
            const nextFirst = { ...first, accounts: [...first.accounts, a] };
            qc.setQueryData<AdminAccountsPage>(firstKey, nextFirst);
            setMore({ source: nextFirst, pages });
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
  const update = useAppMutation({
    fn: (patch: AccountPatch) => updateAdminAccount(account.id, patch),
    invalidates: () => [],
  });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { account: updated } = await update.mutateAsync(PATCH[action]);
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
        <Text variant="prose">{t(`confirm.${action}Hint`, { name })}</Text>
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
  // The overview counts the accounts.
  const create = useAppMutation({
    fn: createAdminAccount,
    invalidates: () => [keys.deployment().adminOverview()],
  });

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await create.mutateAsync({
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
