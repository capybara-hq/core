import {
  listComponentVersions,
  listOrgComponents,
  listPlatformComponents,
  type PlatformComponentKind,
} from "../components";
import { pluginScopeChangeKeys } from "./catalog";
import { defineQuery } from "./define";
import { keys } from "./keys";

const d = () => keys.deployment();

/** The deployment's platform components of one kind (the admin 技能 / 模板 pages). */
export const adminComponentsQuery = (kind: PlatformComponentKind) =>
  defineQuery({
    key: d().components(kind),
    fn: () => listPlatformComponents(kind),
    freshness: "deployment",
  });

/** One platform component's versions, newest first (a 404 is the detail's not-found). */
export const componentVersionsQuery = (kind: PlatformComponentKind, id: string) =>
  defineQuery({
    key: d().componentVersions(kind, id),
    fn: () => listComponentVersions(kind, id),
    freshness: "deployment",
  });

/**
 * What a component's scope, disable, visibility or new version changes: every platform component
 * read, the catalog (its plugin's detail), and in the current org what a plugin change touches
 * (skills, agent templates, connectors).
 */
export const componentChangeKeys = (orgId: string | null): (readonly unknown[])[] =>
  pluginScopeChangeKeys(orgId);

/**
 * The platform components offered to the org (members read them): of one kind (the 技能 / 智能体模板
 * pages) or of one plugin (its detail).
 */
export const orgComponentsQuery = (
  orgId: string,
  filter: { kind?: PlatformComponentKind; itemId?: string },
) =>
  defineQuery({
    key: keys.org(orgId).components(filter.kind ?? "", filter.itemId ?? ""),
    fn: () => listOrgComponents(orgId, filter),
    freshness: "orgConfig",
  });
