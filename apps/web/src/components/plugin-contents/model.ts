import type { ReactNode } from "react";
import type { PackageWarning } from "../../lib/admin-extensions";
import type { LocalizedName, SourceDetail, TranslationReport } from "../../lib/catalog";
import type { PermissionGroup, PermissionItem } from "../../lib/extensions";

/**
 * One contents view of a plugin package (plugin contents spec): every surface that shows what a
 * package holds builds a {@link PluginContentsModel} with an adapter (`fromReview`, …) and draws it
 * with `PluginContents`, passing its stage and audience and filling the rows' trailing slot.
 */

/** Where the contents are shown: the version chip and the extension's note line follow it. */
export type Stage = "install" | "update" | "enable" | "detail";

/** Who reads them: an org admin sees the publisher only (no source, build, license, translation). */
export type Audience = "platform" | "org";

/** A change an update makes to a row, drawn as a badge with its change word. */
export type RowMark = "added" | "removed" | "upgrade" | "downgrade";

/** What every row carries: a stable key, its name, an optional change mark and a trailing slot. */
interface RowBase {
  key: string;
  name: string;
  mark?: RowMark;
  /** Per-surface text or control at the end of the row's title line (a state, a scope link). */
  trailing?: ReactNode;
}

export interface SkillRow extends RowBase {
  kind: "skill";
  description: string;
  /** The files the skill holds (unknown outside a package review). */
  files?: number;
  /** The SKILL.md text, opened inline under the row when present. */
  body?: string;
}

export interface TemplateRow extends RowBase {
  kind: "connectorTemplate";
  /** The template id within its plugin. */
  id: string;
  icon?: string | null;
  description: string;
  /** The default endpoint; its `url` host is the row's toggle line. */
  endpoint?: Record<string, unknown>;
  /** Endpoint paths an org may change. */
  editableEndpoint?: string[];
  auth?: Record<string, unknown>;
  /** What the template needs before it can be used. */
  need?: "client" | "credential";
  /** false: the connector extension did not check the endpoint. */
  endpointChecked?: boolean;
  /** An org gets no connector from it until someone creates one. */
  defaultOff?: boolean;
}

export type AgentTier = "inherit" | "fast" | "standard" | "capable";

/** One connector an agent template needs: a template's name, or a described need and its host. */
export interface AgentNeed {
  label: string;
  host?: string;
}

export interface AgentRow extends RowBase {
  kind: "agentTemplate";
  description: string;
  model?: AgentTier;
  /** undefined: the tools of the agent that dispatches it. */
  tools?: string[];
  disallowedTools?: string[];
  needs: AgentNeed[];
  instructions?: string;
}

export interface ThemeRow extends RowBase {
  kind: "theme";
  description?: string;
}

export type ContentsRow = SkillRow | TemplateRow | AgentRow | ThemeRow;

export interface ProvidesEntry {
  value: string;
  sensitive: boolean;
  /** The sensitive reason code (`extensions.review.reason.*`). */
  reason?: string;
  /** New in this update (the 新增 mark). */
  added?: boolean;
}

export interface ConfigField {
  /** The top-level field name. */
  name: string;
  secret: boolean;
  added?: boolean;
}

export interface ContentsExtension {
  name: string;
  /** The extension already installed is kept at this version. */
  keptVersion?: string;
  provides: ProvidesEntry[];
  config: ConfigField[];
  /** Whether the extension has config to fill in (the note line under it). */
  needsConfig: boolean;
  /** The rest of the permission review (the groups not drawn as 提供 / 配置). */
  permissions?: {
    groups: PermissionGroup[];
    added?: PermissionItem[];
    removed?: string[];
    warnings: PackageWarning[];
    clientFiles?: { path: string; bytes: number }[];
  };
  mark?: RowMark;
  /** Per-surface lines under the block (client code, UI components). */
  trailing?: ReactNode;
}

export interface ContentsDependency {
  name: string;
  range: string;
  /** The version it will use; null: none on the platform yet. */
  resolved: string | null;
  /** The dependency's page. */
  href?: string;
  mark?: RowMark;
  trailing?: ReactNode;
}

export interface ContentsLicense {
  /** The SPDX name, else "LICENSE". */
  name: string;
  /** The text; absent when there is none or it was too large to keep. */
  text?: string;
  truncated?: boolean;
}

export interface ContentsFacts {
  publisher?: string;
  /** Where the package came from (platform only). */
  origin?: { chip?: "npm" | "git"; text?: string; detail?: SourceDetail };
  /** A Claude plugin's declared repository (display only, never verified). */
  repository?: string;
  /** The npm provenance, or why it was not checked (platform only). */
  build?: { repository: string; commit: string } | { notChecked: string };
  license?: ContentsLicense;
}

export interface PluginContentsModel {
  head: {
    name: string;
    version: string;
    /** The version the platform has now, when this is an update. */
    fromVersion?: string | null;
    /** The installed extension already satisfies the package: the chip says 保持. */
    keep?: boolean;
    claudeCode?: boolean;
    /** The number of sensitive items (0: no warn chip). */
    sensitive: number;
  };
  /** The whole description in the reader's language ("" without one). */
  description: string;
  facts: ContentsFacts;
  /** Platform notices on the package itself. */
  notices?: {
    buildVersion?: { version: string; pluginVersion: string };
    provenanceMismatch?: boolean;
    claudeManifestIgnored?: boolean;
  };
  extension?: ContentsExtension;
  skills: SkillRow[];
  templates: TemplateRow[];
  agents: AgentRow[];
  themes: ThemeRow[];
  dependencies: ContentsDependency[];
  translation?: TranslationReport;
}

/** A localized name in the reader's language. */
export const nameIn = (n: LocalizedName, locale: string): string => (locale === "zh" ? n.zh : n.en);

/** The first sentence of a description (up to the first CJK full stop or `. `). */
export function firstSentence(text: string): string {
  const cuts = [text.indexOf("。"), text.indexOf(". ")].filter((n) => n >= 0);
  if (cuts.length === 0) return text.trim();
  return text.slice(0, Math.min(...cuts) + 1).trim();
}

/** The host of an endpoint's `url`, if it has one. */
export function hostOf(endpoint: Record<string, unknown> | undefined): string {
  const url = endpoint?.url;
  if (typeof url !== "string") return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
