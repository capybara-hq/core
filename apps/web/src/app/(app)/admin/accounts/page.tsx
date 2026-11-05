import AdminAccounts from "./view";

/**
 * `/admin/accounts` (super admins): the accounts. It reads nothing: the layout prefetches the
 * first page on a first load (`lib/query/routes.ts`).
 */
export default function AdminAccountsPage() {
  return <AdminAccounts />;
}
