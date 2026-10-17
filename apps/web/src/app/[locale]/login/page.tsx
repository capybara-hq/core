"use client";

import { useEffect } from "react";
import { LoginForm } from "../../../components/login-form";
import { useRouter } from "../../../i18n/navigation";
import { getSetupStatus } from "../../../lib/session";

/** `/[locale]/login`：本地登录；系统尚未初始化时转到初始化向导。 */
export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    getSetupStatus()
      .then((s) => {
        if (s.needsSetup) router.replace("/setup");
      })
      // 查询失败不阻塞登录：提交表单时会显示具体错误。
      .catch(() => {});
  }, [router]);

  return <LoginForm onSuccess={() => router.replace("/")} />;
}
