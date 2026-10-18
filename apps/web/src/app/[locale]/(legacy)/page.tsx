"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Link, useRouter } from "../../../i18n/navigation";
import { ApiClientError } from "../../../lib/api";
import { getMe, logout, type Me, setCurrentOrg } from "../../../lib/session";
import { useErrorMessage } from "../../../lib/use-error-message";

/**
 * `/[locale]`：已登录时显示「当前组织」选择与进入 agent 列表的入口；
 * 未登录（`GET /api/v1/me` 401，refresh 也失败）时跳转到登录页。
 */
export default function HomePage() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setMe(await getMe());
      setError(undefined);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 401) router.replace("/login");
      else setError(errorMessage(e));
    }
  }, [router, errorMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSwitchOrg(orgId: string) {
    try {
      await setCurrentOrg(orgId === "" ? null : orgId);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function onLogout() {
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  if (me === undefined) {
    return error === undefined ? (
      <p>{t("common.loading")}</p>
    ) : (
      <p role="alert" className="error">
        {error}
      </p>
    );
  }

  return (
    <div className="card wide">
      <div className="row">
        <h1>{t("home.greeting", { name: me.account.displayName })}</h1>
        <button type="button" className="secondary" onClick={onLogout}>
          {t("common.logout")}
        </button>
      </div>

      <h2>{t("home.currentOrg")}</h2>
      {me.memberships.length === 0 ? (
        <p>{t("home.noMemberships")}</p>
      ) : (
        <select
          aria-label={t("home.currentOrg")}
          value={me.currentOrgId ?? ""}
          onChange={(e) => void onSwitchOrg(e.target.value)}
        >
          <option value="">{t("home.selectOrg")}</option>
          {me.memberships.map((m) => (
            <option key={m.orgId} value={m.orgId}>
              {m.name}
            </option>
          ))}
        </select>
      )}
      {error !== undefined && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {me.currentOrgId !== null && (
        <>
          <h2>{t("home.agents")}</h2>
          <Link href="/agents">{t("home.openAgents")}</Link>
        </>
      )}
    </div>
  );
}
