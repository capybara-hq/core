"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { AgentTemplateDetail } from "../../lib/agents";
import { ownerSide } from "../../lib/catalog";
import { retryOnMountOf } from "../../lib/query/client";
import { orgComponentsQuery } from "../../lib/query/components";
import { parseToolKey } from "../../lib/tool-key";
import { useTemplateSource as useCardSource } from "../AgentTemplateCards";
import { useTemplatePage } from "./frame";

/** The template's source as the cards say it (ruling P4-15): 平台 / 本组织 / org / 插件 · name. */
export function useTemplateSource(): (t: AgentTemplateDetail, orgId: string) => string {
  const card = useCardSource();
  return (t, orgId) => card(t.plugin, t.owned ? { kind: "self" } : ownerSide(t.owner, orgId));
}

/**
 * How a tool key reads: a builtin by its label (`AskUserQuestion` -> 向用户提问), an extension
 * tool as `<plugin> · <tool>`, anything else as the key.
 */
export function useToolName(): (key: string) => string {
  const t = useTranslations("agents.form.builtin");
  return (key) => {
    const p = parseToolKey(key);
    if (p?.kind === "builtin") return t.has(p.name) ? t(p.name) : p.name;
    if (p?.kind === "extension") return `${p.plugin} · ${p.tool}`;
    return key;
  };
}

/**
 * A platform connector template's name by its id (a template entry, ruling T4-R1), from the
 * components offered to the org; its id when the list is not readable or does not have it.
 */
export function useConnectorTemplateName(): (id: string) => string {
  const { orgId } = useTemplatePage();
  const q = orgComponentsQuery(orgId, {});
  const offered = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  return (id) =>
    offered.data?.components.find((c) => c.kind === "connector_template" && c.id === id)?.name ??
    id;
}
