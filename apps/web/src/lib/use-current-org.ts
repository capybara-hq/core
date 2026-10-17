"use client";

import { useEffect, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError } from "./api";
import { getMe } from "./session";
import { useErrorMessage } from "./use-error-message";

export type CurrentOrg =
  | { kind: "loading" }
  | { kind: "ready"; orgId: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

/** 当前组织（`GET /api/v1/me` 的 `currentOrgId`）；未登录时跳转到登录页。 */
export function useCurrentOrg(): CurrentOrg {
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<CurrentOrg>({ kind: "loading" });
  useEffect(() => {
    let disposed = false;
    getMe().then(
      (me) => {
        if (disposed) return;
        setState(
          me.currentOrgId === null ? { kind: "none" } : { kind: "ready", orgId: me.currentOrgId },
        );
      },
      (e: unknown) => {
        if (disposed) return;
        if (e instanceof ApiClientError && e.status === 401) router.replace("/login");
        else setState({ kind: "error", message: errorMessage(e) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [router, errorMessage]);
  return state;
}
