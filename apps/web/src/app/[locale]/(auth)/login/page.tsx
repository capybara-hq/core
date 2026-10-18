"use client";

import { AuthPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { LocaleLinks } from "../../../../components/locale-links";
import { LoginForm } from "../../../../components/login-form";
import { useRouter } from "../../../../i18n/navigation";
import { getSetupStatus } from "../../../../lib/session";

/** `/[locale]/login`：本地登录（AuthPage）；系统尚未初始化时转到初始化向导。 */
export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();

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
      <LoginForm onSuccess={() => router.replace("/")} />
    </AuthPage>
  );
}
