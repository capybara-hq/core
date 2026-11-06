"use client";

import {
  type ActionRowProps,
  Callout,
  ErrorDetail,
  type FieldShape,
  type PageHeaderProps,
  SettingsPage,
  Stack,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import {
  definitionOf,
  type TemplateDefinition,
  updateAgentTemplate,
} from "../../lib/agent-templates";
import type { AgentTemplateDetail } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";

/**
 * The template page's sections (ruling P4-12: the agent editor's sections, in the agent page's
 * order, without 渠道: a template has no channels; 连接器 is its own section because a template
 * names connectors, not the org's connector tools). `?s=` keeps the open one.
 */
export const TEMPLATE_SECTIONS = [
  "basics",
  "quick-actions",
  "prompt",
  "model",
  "tools",
  "skills",
  "connectors",
  "subagents",
] as const;
export type TemplateSection = (typeof TEMPLATE_SECTIONS)[number];

/** The section `?s=` opens: an unknown one opens `basics`. */
export const templateSectionOf = (s: string | undefined): TemplateSection =>
  (TEMPLATE_SECTIONS as readonly string[]).includes(s ?? "") ? (s as TemplateSection) : "basics";

/** The URL of a section of the template page. */
export const templateSectionHref = (id: string, s: TemplateSection) =>
  `/agents/templates/${encodeURIComponent(id)}?s=${s}`;

/** Each section's loading layout (`SettingsPage loading.sections`), read and edit alike. */
export const TEMPLATE_SECTION_FIELDS: Record<TemplateSection, FieldShape[]> = {
  basics: [{ control: "key-value" }],
  "quick-actions": [{ control: "item-group", options: 2 }],
  prompt: [{ control: "list-editor", options: 1, rows: 16 }],
  model: [{ control: "key-value" }],
  tools: [{ control: "item-group", options: 2 }],
  skills: [{ control: "item-group", options: 2 }],
  connectors: [{ control: "item-group", options: 1 }],
  subagents: [{ control: "item-group", options: 1 }],
};

/** What every section of the template page reads. */
export interface TemplatePageValue {
  orgId: string;
  template: AgentTemplateDetail;
  definition: TemplateDefinition;
  /** Owner-org admin on the org's own template: the editor; else the read view. */
  editable: boolean;
  section: TemplateSection;
  header: PageHeaderProps;
  nav: { group: string; items: { id: string; label: string; href: string }[] }[];
  /** A notice above the open section (the template is off in the org). */
  notice: ReactNode;
  setDirty(dirty: boolean): void;
}

export const TemplatePageContext = createContext<TemplatePageValue | null>(null);

export function useTemplatePage(): TemplatePageValue {
  const v = useContext(TemplatePageContext);
  if (v === null) throw new Error("useTemplatePage outside TemplatePage");
  return v;
}

/** The section nav (every section, for members and admins alike). */
export function useTemplateNav(id: string) {
  const t = useTranslations("agents.templatePage");
  return [
    {
      group: t("navGroup"),
      items: TEMPLATE_SECTIONS.map((s) => ({
        id: s,
        label: t(`sections.${s}`),
        href: templateSectionHref(id, s),
      })),
    },
  ];
}

/**
 * One section of the template page: the `SettingsPage` template with the page's head and nav,
 * the page's notice, the section and its own action row while it has changes. `loading` draws
 * the section's static layout while its reads are on the way.
 */
export function TemplateSectionFrame({
  actionRow,
  dirty = false,
  loading = false,
  children,
}: {
  actionRow?: ActionRowProps | undefined;
  dirty?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  const page = useTemplatePage();
  const t = useTranslations("agents.templatePage");
  const { setDirty } = page;
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
  return (
    <SettingsPage
      header={page.notice === null ? page.header : { ...page.header, notice: page.notice }}
      nav={page.nav}
      activeNav={page.section}
      {...(actionRow ? { actionRow } : {})}
      {...(loading
        ? {
            loading: {
              sections: [
                {
                  fields: TEMPLATE_SECTION_FIELDS[page.section],
                  title: t(`sections.${page.section}`),
                },
              ],
            },
          }
        : {})}
    >
      {children}
    </SettingsPage>
  );
}

export type TemplateSaveResult = { saved: true } | { saved: false; error: unknown };

/** What {@link useTemplateSave} gives an editing section. */
export interface TemplateSave {
  pending: boolean;
  error: unknown;
  /** Call on each edit: the first one takes the version the edit is made on. */
  begin(): void;
  /** Sends the whole definition with `expectedVersion` (a new template version). */
  send(definition: TemplateDefinition): Promise<TemplateSaveResult>;
  clear(): void;
  /** Reads the template again, then calls `after` (the section starts over from it). */
  reload(after: () => void): Promise<void>;
}

/**
 * One section's save (ruling P4-12): `PUT …/agent-templates/:id` with the whole definition (the
 * saved one with the section's part changed) and the version its first edit was made on, so a
 * save over someone else's newer version is 409 `agent_template.version_conflict` with a reload,
 * never a silent overwrite. Each save writes a new version; the answer is the new detail.
 */
export function useTemplateSave(): TemplateSave {
  const qc = useQueryClient();
  const { orgId, template } = useTemplatePage();
  const [base, setBase] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const k = keys.org(orgId);
  const mutation = useAppMutation({
    fn: (input: { definition: TemplateDefinition; expectedVersion: number }) =>
      updateAgentTemplate(orgId, template.id, input),
    // the detail (every id it is cached under), the usable set and the offered components
    invalidates: () => [k.agentTemplateAll(), k.agentTemplates(), k.componentsAll()],
  });
  const clear = () => {
    setBase(null);
    setError(null);
  };
  return {
    pending,
    error,
    begin: () => setBase((b) => b ?? template.version),
    async send(definition) {
      setPending(true);
      setError(null);
      try {
        await mutation.mutateAsync({ definition, expectedVersion: base ?? template.version });
        setBase(null);
        return { saved: true };
      } catch (e) {
        setError(e);
        return { saved: false, error: e };
      } finally {
        setPending(false);
      }
    },
    clear,
    async reload(after) {
      await qc.refetchQueries({ queryKey: k.agentTemplateAll() });
      clear();
      after();
    },
  };
}

/**
 * The saved definition with `patch` over it (the name never changes); a key patched to
 * `undefined` is removed (absent, never `null`).
 */
export function withDefinition(
  t: AgentTemplateDetail,
  patch: { [K in keyof TemplateDefinition]?: TemplateDefinition[K] | undefined },
): TemplateDefinition {
  const out: Record<string, unknown> = { ...definitionOf(t), ...patch, name: t.name };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as TemplateDefinition;
}

/**
 * A save's failure above the section: a version conflict offers the reload; anything else is
 * the localized message (`extra`: the lines no field shows).
 */
export function TemplateSaveFeedback({
  save,
  onReload,
  extra = [],
}: {
  save: TemplateSave;
  onReload(): void;
  extra?: string[];
}) {
  const t = useTranslations("agents.page");
  const errorMessage = useErrorMessage();
  const { error } = save;
  if (error === null) return null;
  if (error instanceof ApiClientError && error.code === "agent_template.version_conflict") {
    return (
      <Callout tone="fail" action={{ label: t("reload"), onSelect: onReload }}>
        {errorMessage(error)}
      </Callout>
    );
  }
  // the kernel's own words (English) stay behind 原始错误
  const raw =
    error instanceof ApiClientError
      ? [error.message, ...error.details.map((d) => `${d.path}: ${d.message}`)].join("\n")
      : "";
  return (
    <Stack gap={4}>
      <ErrorDetail summary={errorMessage(error)} {...(raw !== "" ? { detail: raw } : {})} />
      {extra.length > 0 ? <FormError message={extra[0] ?? ""} extra={extra.slice(1)} /> : null}
    </Stack>
  );
}
