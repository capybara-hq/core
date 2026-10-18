"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SetupForm } from "../../../components/setup-form";
import { Link, useRouter } from "../../../i18n/navigation";
import { getSetupStatus } from "../../../lib/session";
import { useErrorMessage } from "../../../lib/use-error-message";

type State =
  | { kind: "loading" }
  | { kind: "ready"; needsSetup: boolean }
  | { kind: "error"; message: string };

/** `/[locale]/setup`：初始化向导（`GET` / `POST /api/v1/setup`）。 */
export default function SetupPage() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    getSetupStatus()
      .then((s) => setState({ kind: "ready", needsSetup: s.needsSetup }))
      .catch((e: unknown) => setState({ kind: "error", message: errorMessage(e) }));
  }, [errorMessage]);

  if (state.kind === "loading") return <p>{t("common.loading")}</p>;
  if (state.kind === "error") {
    return (
      <p role="alert" className="error">
        {state.message}
      </p>
    );
  }
  if (!state.needsSetup) {
    return (
      <div className="card">
        <p>{t("setup.alreadyDone")}</p>
        <Link href="/login">{t("setup.goToLogin")}</Link>
      </div>
    );
  }
  return <SetupForm onSuccess={() => router.replace("/")} />;
}
