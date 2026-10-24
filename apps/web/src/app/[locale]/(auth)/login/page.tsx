"use client";

import { AuthPage, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { LocaleLinks } from "../../../../components/locale-links";
import {
  InsecureOriginNotice,
  LoginErrorNotice,
  LoginForm,
  SsoButtons,
} from "../../../../components/login-form";
import { useRouter } from "../../../../i18n/navigation";
import { type LoginErrorCode, parseLoginError, safeReturnTo } from "../../../../lib/auth-sources";
import { getSetupStatus } from "../../../../lib/session";

/**
 * `/[locale]/login`：本地登录与第三方登录按钮（AuthPage）；系统尚未初始化时转到初始化向导。
 * `?returnTo=<站内路径>`：登录后回到该页（如绑定确认页）；`?error=<code>`：第三方登录失败的原因码。
 */
export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  // 查询串只在浏览器里读（不用 useSearchParams：避免整页退化为客户端渲染的 Suspense 要求）
  const [returnTo, setReturnTo] = useState("/");
  const [error, setError] = useState<LoginErrorCode | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReturnTo(safeReturnTo(params.get("returnTo")));
    setError(parseLoginError(window.location.search));
  }, []);

  useEffect(() => {
    getSetupStatus()
      .then((s) => {
        if (s.needsSetup) router.replace("/setup");
      })
      // 查询失败不阻塞登录：提交表单时会显示具体错误。
      .catch(() => {});
  }, [router]);

  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} footer={<LocaleLinks />}>
      <Stack gap={16}>
        <InsecureOriginNotice />
        {error !== null && <LoginErrorNotice code={error} />}
        <LoginForm onSuccess={() => router.replace(returnTo)} />
        <SsoButtons returnTo={returnTo} />
      </Stack>
    </AuthPage>
  );
}
