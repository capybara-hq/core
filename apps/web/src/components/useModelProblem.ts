"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ModelListErrorKind, OrgReadiness } from "../lib/agents";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { modelConfigViewer, noModelsHref } from "../lib/model-config";
import { meQuery, readinessQuery } from "../lib/query/shell";

/** How a failed list reads (`setupLayout.model.problem.cause.*`). */
type Cause = "auth" | "rateLimited" | "timeout" | "unavailable" | "failed";

const CAUSE: Record<ModelListErrorKind, Cause> = {
  auth: "auth",
  rate_limited: "rateLimited",
  timeout: "timeout",
  network: "unavailable",
  server: "unavailable",
  overloaded: "unavailable",
  invalid_request: "failed",
  context_overflow: "failed",
  refusal: "failed",
  aborted: "failed",
  unknown: "failed",
};

/**
 * Why the org has no model to pick (readiness `no_models`), one clause per provider that is on but
 * gives none, naming it ("DeepSeek could not list its models (key rejected)", "DeepSeek has no chat
 * model available"). Null for any other readiness (or none read).
 */
export function useModelProblem(r: OrgReadiness | null | undefined): string | null {
  const t = useTranslations("setupLayout.model.problem");
  const lang = labelLocale(useLocale());
  if (r?.modelProvider !== "no_models" || r.unusableProviders.length === 0) return null;
  const parts = r.unusableProviders.map((p) => {
    const provider = extensionLabel({ name: p.provider, displayName: p.displayName }, lang);
    return p.reason === "list_failed"
      ? t("listFailed", { provider, cause: t(`cause.${CAUSE[p.errorKind] ?? "failed"}`) })
      : t("noChatModels", { provider });
  });
  return parts.join(t("separator"));
}

/**
 * What a model picker with no option says (the agent form, the template dialog) while `active`:
 * when the org's readiness is `no_models` (a provider is on but its list failed or gives no chat
 * model), that the configured model services list no usable model and why, with where the viewer
 * fixes it ({@link noModelsHref}; null: they wait); null otherwise (the picker keeps its own
 * message). Reads the readiness and `/me` the shell already has in the cache.
 */
export function useNoModelsHint(
  orgId: string,
  active: boolean,
): { error: string; href: "/settings/models" | "/admin/models" | null } | null {
  const t = useTranslations("agents.form");
  const readiness = useQuery({ ...readinessQuery(orgId), enabled: active }).data;
  const me = useQuery({ ...meQuery(), enabled: active }).data;
  const problem = useModelProblem(readiness);
  if (!active || problem === null || readiness === undefined) return null;
  return {
    error: t("noUsableModels", { problem }),
    href: me === undefined ? null : noModelsHref(readiness, modelConfigViewer(me)),
  };
}
