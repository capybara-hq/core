"use client";

import { type ActionRowProps, type PageHeaderProps, SettingsPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { Agent } from "../../lib/agents";
import {
  type AgentSection,
  READ_ONLY_FIELDS,
  SECTION_FIELDS,
  sectionHref,
  sectionsFor,
} from "./sections";

/** What every section of the agent page reads: the agent, who is looking, the open section. */
export interface AgentPageValue {
  orgId: string;
  agent: Agent;
  /** The viewer may change the agent (owner or org admin); else every section is read-only. */
  editable: boolean;
  section: AgentSection;
  header: PageHeaderProps;
  nav: { group: string; items: { id: string; label: string; href: string }[] }[];
  /** A section reports its unsaved edits, so leaving it asks first. */
  setDirty(dirty: boolean): void;
}

export const AgentPageContext = createContext<AgentPageValue | null>(null);

/** The agent page's context; only inside {@link AgentPage}. */
export function useAgentPage(): AgentPageValue {
  const v = useContext(AgentPageContext);
  if (v === null) throw new Error("useAgentPage outside AgentPage");
  return v;
}

/** The nav of the sections this viewer sees. */
export function useSectionNav(agentId: string, editable: boolean) {
  const t = useTranslations("agents.page");
  return [
    {
      group: t("navGroup"),
      items: sectionsFor(editable).map((s) => ({
        id: s,
        label: t(`sections.${s}`),
        href: sectionHref(agentId, s),
      })),
    },
  ];
}

/**
 * One section of the agent page: the `SettingsPage` template with the page's head and section
 * nav, the section's content, and its own action row (Save, Discard) while it has changes.
 * `dirty` tells the page the section holds unsaved edits; `loading` draws the section's static
 * field layout while its reads are on the way.
 */
export function AgentSectionFrame({
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
  const page = useAgentPage();
  const t = useTranslations("agents.page");
  const { setDirty } = page;
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
  const fields = page.editable
    ? SECTION_FIELDS[page.section]
    : (READ_ONLY_FIELDS[page.section] ?? SECTION_FIELDS[page.section]);
  return (
    <SettingsPage
      header={page.header}
      nav={page.nav}
      activeNav={page.section}
      {...(actionRow ? { actionRow } : {})}
      {...(loading
        ? { loading: { sections: [{ fields, title: t(`sections.${page.section}`) }] } }
        : {})}
    >
      {children}
    </SettingsPage>
  );
}
