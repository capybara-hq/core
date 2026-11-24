import {
  descriptionOf,
  type PluginReview,
  type PluginReviewAgentConnector,
  type PluginReviewExtension,
  templateNeed,
} from "../../lib/catalog";
import type {
  AgentNeed,
  ContentsExtension,
  ContentsFacts,
  PluginContentsModel,
  TemplateRow,
} from "./model";
import { hostOf, nameIn } from "./model";

/** The top-level name of a config field path (`deployment:sandbox.apiKey` -> `sandbox`). */
const topLevelField = (item: string): string =>
  (item.startsWith("deployment:") ? item.slice("deployment:".length) : item).split(".")[0] ?? item;

const isDeploymentSecret = (item: string) => item.startsWith("deployment:");

/**
 * The sensitive items of a review as one number: the sensitive entries of the extension's
 * permissions plus its migration warnings (never fewer than one when the kernel marks the review
 * sensitive for another reason).
 */
function sensitiveTotal(review: PluginReview): number {
  const ext = review.extension;
  const n =
    ext === undefined
      ? 0
      : ext.permissions.flatMap((g) => g.entries).filter((e) => e.sensitive).length +
        ext.warnings.length;
  return n === 0 && review.sensitive ? 1 : n;
}

/**
 * An extension in the contents: what it provides, its top-level config fields (a lock on the
 * secret ones) and, for the permission review under them, the rest of its permissions. On an
 * update, what the new version added to the provides and config rows is marked.
 */
function extensionOf(extension: PluginReviewExtension): ContentsExtension {
  const provides = extension.permissions.find((g) => g.category === "provides");
  const config = [
    ...new Set(
      (extension.permissions.find((g) => g.category === "config")?.items ?? []).map(topLevelField),
    ),
  ];
  const secrets = new Set(
    (extension.permissions.find((g) => g.category === "secrets")?.items ?? [])
      .filter(isDeploymentSecret)
      .map(topLevelField),
  );
  // The config fields and the provides row are drawn apart; the secret fields are chips with a lock
  const rest = extension.permissions
    .filter((g) => g.category !== "provides" && g.category !== "config")
    .map((g) =>
      g.category === "secrets"
        ? {
            ...g,
            items: g.items.filter((i) => !isDeploymentSecret(i)),
            entries: g.entries.filter((e) => !isDeploymentSecret(e.value)),
          }
        : g,
    )
    .filter((g) => g.entries.length > 0);
  const upgrade = extension.action === "upgrade";
  const addedKeys = upgrade ? extension.addedItems.map((a) => a.value) : [];
  const addedProvides = new Set(
    addedKeys.filter((k) => k.startsWith("provides:")).map((k) => k.slice("provides:".length)),
  );
  const addedConfig = new Set(
    addedKeys
      .filter((k) => /^config\.(deployment|org)(\.secret)?:/.test(k))
      .map((k) => topLevelField(k.slice(k.indexOf(":") + 1))),
  );
  const showPermissions =
    rest.length > 0 ||
    extension.warnings.length > 0 ||
    extension.permissions.length === 0 ||
    (upgrade && (extension.addedItems.length > 0 || extension.removed.length > 0));
  return {
    name: extension.name,
    ...(extension.action === "keep" && {
      keptVersion: extension.currentVersion ?? extension.version,
    }),
    provides: (provides?.entries ?? []).map((e) => ({
      value: e.value,
      sensitive: e.sensitive,
      ...(e.reason !== undefined && { reason: e.reason }),
      ...(addedProvides.has(e.value) && { added: true }),
    })),
    config: config.map((name) => ({
      name,
      secret: secrets.has(name),
      ...(addedConfig.has(name) && { added: true }),
    })),
    needsConfig: config.length > 0,
    ...(showPermissions && {
      permissions: {
        groups: rest,
        ...(upgrade && { added: extension.addedItems, removed: extension.removed }),
        warnings: extension.warnings,
        ...(extension.client !== undefined && {
          clientFiles: extension.client.files.map((f) => ({ path: f.path, bytes: f.size })),
        }),
      },
    }),
  };
}

/** The facts of a review: publisher, source, declared repository, build and license. */
function factsOf(review: PluginReview): ContentsFacts {
  const detail = review.source.detail;
  const provenance = review.provenance;
  // Provenance exists only for npm packages: an npm import or a marketplace entry from the registry
  const fromNpm = review.source.kind === "npm" || (detail !== undefined && "registry" in detail);
  const fromGit = review.source.kind === "git" || (detail !== undefined && "repo" in detail);
  const licenseText = typeof review.licenseText === "string" ? review.licenseText : "";
  const licenseName = review.license !== undefined && review.license !== "" ? review.license : "";
  const license =
    licenseText !== ""
      ? { name: licenseName || "LICENSE", text: licenseText }
      : review.licenseTruncated === true
        ? { name: licenseName || "LICENSE", truncated: true }
        : licenseName !== ""
          ? { name: licenseName }
          : undefined;
  return {
    ...(review.publisher !== "" && { publisher: review.publisher }),
    ...((review.packageName !== null || detail !== undefined) && {
      origin: {
        ...((fromNpm || fromGit) && { chip: fromNpm ? ("npm" as const) : ("git" as const) }),
        ...(detail !== undefined && (fromGit || review.packageName === null)
          ? { detail }
          : { text: review.packageName ?? "" }),
      },
    }),
    // display only: never fetched or compared with the source
    ...(review.repository !== undefined && { repository: review.repository }),
    // display only: the attestation's signatures are not verified
    ...(provenance.checked
      ? { build: { repository: provenance.repository, commit: provenance.commit } }
      : fromNpm
        ? { build: { notChecked: provenance.reason } }
        : {}),
    ...(license !== undefined && { license }),
  };
}

/**
 * The contents of a staged plugin import (the platform's install and update, an org's upload).
 * `installedVersion` is the version the platform has when the import updates it: the head then
 * reads from → to whether or not the package has an extension.
 */
export function fromReview(
  review: PluginReview,
  opts: { installedVersion?: string | null; locale: string },
): PluginContentsModel {
  const { locale } = opts;
  const installed = opts.installedVersion ?? null;
  const ext = review.extension;
  const fromVersion =
    installed !== null && installed !== review.version
      ? installed
      : ext?.action === "upgrade" && ext.currentVersion != null
        ? ext.currentVersion
        : null;
  const templates: TemplateRow[] = review.connectorTemplates.map((c) => {
    const need = templateNeed(c);
    return {
      kind: "connectorTemplate",
      key: c.id,
      id: c.id,
      name: nameIn(c.displayName, locale) || c.id,
      icon: c.icon,
      description: descriptionOf(c, locale),
      endpoint: c.endpoint,
      editableEndpoint: c.editableEndpoint,
      auth: c.auth,
      ...(need !== undefined && { need }),
      endpointChecked: c.endpointChecked,
    };
  });
  /**
   * One connector an agent template needs: a template of this plugin by its display name (`<id>`
   * or `<this plugin>:<id>`), another plugin's by its reference, a described need by its label and
   * the endpoint's host.
   */
  const needOf = (c: PluginReviewAgentConnector): AgentNeed => {
    if ("needs" in c) {
      const host = hostOf({ url: c.needs.endpoint });
      return host === "" ? { label: c.needs.label } : { label: c.needs.label, host };
    }
    const [plugin, id] = c.template.includes(":")
      ? (c.template.split(":", 2) as [string, string])
      : [review.name, c.template];
    const own = plugin === review.name ? templates.find((x) => x.id === id) : undefined;
    return { label: own === undefined ? c.template : own.name };
  };
  return {
    head: {
      name: review.displayName === undefined ? review.name : nameIn(review.displayName, locale),
      version: review.version,
      fromVersion,
      keep: fromVersion === null && ext?.action === "keep",
      claudeCode: review.format === "claude-code",
      sensitive: sensitiveTotal(review),
    },
    description: descriptionOf(review, locale),
    facts: factsOf(review),
    notices: {
      ...(review.pluginVersion !== undefined && {
        buildVersion: { version: review.version, pluginVersion: review.pluginVersion },
      }),
      ...(review.provenanceWarning === "repository_mismatch" && { provenanceMismatch: true }),
      ...(review.claudeManifestIgnored === true && { claudeManifestIgnored: true }),
    },
    ...(ext !== undefined && { extension: extensionOf(ext) }),
    skills: review.skills.map((s) => ({
      kind: "skill",
      key: s.path,
      name: s.name,
      description: s.description,
      files: s.files,
      body: s.body,
    })),
    templates,
    agents: (review.agentTemplates ?? []).map((a) => ({
      kind: "agentTemplate",
      key: a.path,
      name: a.name,
      description: a.description,
      model: a.model,
      ...(a.tools !== undefined && { tools: a.tools }),
      ...(a.disallowedTools !== undefined && { disallowedTools: a.disallowedTools }),
      needs: a.connectors.map(needOf),
      instructions: a.instructions,
    })),
    themes: [],
    dependencies: review.dependencies.map((d) => ({
      name: d.name,
      range: d.range,
      resolved: d.resolved,
    })),
    ...(review.translation !== undefined && { translation: review.translation }),
  };
}
