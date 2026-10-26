import { readFile } from "node:fs/promises";
import {
  type CatalogCli,
  type KernelLogger,
  openCatalogCli,
  type PluginReview,
} from "@capybara-hq/kernel";
import { readLine } from "./admin-create.js";
import { type ExtensionsIo, parseInstallTarget, withOpened } from "./extensions.js";

/** Input and output streams of the plugins commands (replaceable in tests). */
export type PluginsIo = ExtensionsIo;

const defaultIo = (): PluginsIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withCatalog = <T>(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  fn: (cli: CatalogCli) => Promise<T>,
) => withOpened(log, env, (config) => openCatalogCli(config, log), fn);

/** `capybara plugins list`: the catalog's items with their latest version, components and policy. */
export async function runPluginsList(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCatalog(log, env, async (cli) => {
      const items = [];
      for (let offset: number | null = 0; offset !== null; ) {
        const page = await cli.catalog.page({ offset });
        items.push(...page.items);
        offset = page.nextOffset;
      }
      if (items.length === 0) {
        io.stdout.write("No plugins in the catalog.\n");
        return 0;
      }
      const lines = [["NAME", "VERSION", "COMPONENTS", "POLICY"].join("\t")];
      for (const item of items) {
        const { versions } = await cli.catalog.get(item.id);
        const m = versions.find((v) => v.version === item.latestVersion)?.manifest;
        const components = [
          ...(m?.extension ? ["extension"] : []),
          ...(m?.skills && m.skills.length > 0 ? [count(m.skills.length, "skill")] : []),
          ...(m?.connectorTemplates && m.connectorTemplates.length > 0
            ? [count(m.connectorTemplates.length, "connector template")]
            : []),
        ];
        lines.push(
          [item.name, item.latestVersion, components.join(", ") || "-", item.policy].join("\t"),
        );
      }
      io.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins list failed: ${errMsg(e)}\n`);
    return 1;
  }
}

const GIT_TARGET_USAGE = "git:<url>[#<ref>][:<path>]";

/** The target of `plugins import`: a file, an npm package, or a git repository (folder). */
export type PluginsImportTarget =
  | ReturnType<typeof parseInstallTarget>
  | { kind: "git"; url: string; ref?: string; path?: string };

/**
 * Parses `<file.tgz>`, `npm:<name>[@<version>]` and `git:<url>[#<ref>][:<path>]`. The url is an
 * https URL or the GitHub shorthand `owner/repo`; `:<path>` starts at the first colon after the
 * ref, or (without a ref) the first colon in the URL's path, so a port in the URL is not a path.
 */
export function parsePluginsImportTarget(target: string): PluginsImportTarget {
  if (!target.startsWith("git:")) return parseInstallTarget(target);
  const spec = target.slice(4);
  const bad = () => new Error(`plugins import: "${target}" is not of the form ${GIT_TARGET_USAGE}`);
  let url: string;
  let ref: string | undefined;
  let path: string | undefined;
  const hash = spec.indexOf("#");
  if (hash >= 0) {
    url = spec.slice(0, hash);
    const rest = spec.slice(hash + 1);
    const colon = rest.indexOf(":");
    ref = colon >= 0 ? rest.slice(0, colon) : rest;
    if (colon >= 0) path = rest.slice(colon + 1);
  } else {
    const scheme = spec.indexOf("://");
    const pathStart = scheme >= 0 ? spec.indexOf("/", scheme + 3) : 0;
    const colon = pathStart >= 0 ? spec.indexOf(":", pathStart) : -1;
    url = colon >= 0 ? spec.slice(0, colon) : spec;
    if (colon >= 0) path = spec.slice(colon + 1);
  }
  if (url === "" || ref === "" || path === "") throw bad();
  return {
    kind: "git",
    url,
    ...(ref !== undefined && { ref }),
    ...(path !== undefined && { path }),
  };
}

const EXTENSION_ACTION_TEXT = {
  install: () => "not installed on this deployment",
  upgrade: (current: string | null) => `installed at ${current}, replaced when deployed`,
  keep: () => "this exact package is installed",
};

/** The review as printed before the confirmation: every component the admin confirms. */
export function describeReview(r: PluginReview): string[] {
  const out = [
    `${r.name} ${r.version}${r.packageName !== null ? ` (${r.packageName})` : ""} by ${r.publisher}`,
    `  ${r.description}`,
    `  source: ${r.source.kind} ${r.source.ref}`,
  ];
  if (r.pluginVersion !== undefined) {
    out.push(
      `  version: ${r.version} (plugin.json says ${r.pluginVersion}; that version is already imported with other content)`,
    );
  }
  const d = r.source.detail;
  if (d !== undefined && "commit" in d) {
    const pin = d.followsBranch ? `ref ${d.ref ?? "HEAD"}, follows the branch` : "pinned";
    out.push(
      `  git: ${d.host} ${d.repo}${d.path !== "." ? ` path ${d.path}` : ""}, commit ${d.commit} (${pin})`,
    );
  }
  out.push(`  content digest: ${r.contentDigest}`);
  const p = r.provenance;
  out.push(
    p.checked
      ? `  provenance: built from ${p.repository}@${p.commit} by ${p.workflow}`
      : `  provenance not checked: ${p.reason}`,
  );
  if (r.provenanceWarning === "repository_mismatch") {
    out.push("  ! the marketplace's repository differs from the attested repository");
  }
  const e = r.extension;
  if (e) {
    out.push(
      `Extension ${e.name} ${e.version}: ${EXTENSION_ACTION_TEXT[e.action](e.currentVersion)}`,
    );
    for (const g of e.permissions) {
      out.push(`  permissions (${g.sensitive ? "sensitive" : "standard"}): ${g.items.join(", ")}`);
    }
    if (e.permissions.length === 0) out.push("  permissions: none");
    for (const k of e.added) out.push(`  + ${k}`);
    for (const k of e.removed) out.push(`  - ${k}`);
    for (const w of e.warnings) {
      out.push(`  ! [${w.kind}] ${w.file}:${w.line}  ${w.statement}`);
    }
  }
  for (const s of r.skills) {
    out.push(`Skill ${s.name}: ${s.description} (${s.files} files)`);
  }
  for (const t of r.connectorTemplates) {
    out.push(`Connector template ${t.id}: ${t.plugin} / ${t.connector}`);
  }
  for (const d of r.dependencies) {
    out.push(
      `Dependency ${d.name} ${d.range}: ${d.resolved !== null ? `resolves to ${d.resolved}` : "not in the catalog yet (import it before installing this plugin in an organization)"}`,
    );
  }
  if (!e && r.skills.length === 0 && r.connectorTemplates.length === 0) {
    out.push("No components.");
  }
  if (r.claudeManifestIgnored) {
    out.push("  ! .claude-plugin/plugin.json ignored: .capybara-plugin/plugin.json was read");
  }
  if (r.licenseText !== undefined) {
    out.push(`  license text: ${Buffer.byteLength(r.licenseText)} bytes (stored with the version)`);
  } else if (r.licenseTruncated) {
    out.push("  license text: too long or not UTF-8, not stored");
  }
  const t = r.translation;
  if (t !== undefined) {
    const n = (g: string) => t.items.filter((i) => i.group === g).length;
    out.push(
      `Translated from a Claude Code plugin: imported ${n("imported")}, converted ${n("converted")}, needs input ${n("needsInput")}, ignored ${n("ignored")}, warnings ${n("warnings")}`,
    );
    for (const i of t.items) {
      if (i.group === "imported") continue;
      const detail = Object.entries(i.detail ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      out.push(
        `  ${i.group}: ${i.code} ${i.name}${i.path !== undefined ? ` (${i.path})` : ""}${detail !== "" ? ` ${detail}` : ""}`,
      );
    }
  }
  return out;
}

/**
 * `capybara plugins import <file.tgz | npm:<name>[@<ver>] | git:<url>[#<ref>][:<path>]>
 * [--deploy-extension] [--yes]`: prepares the import (reads and checks the whole package or git
 * folder, stages it; git goes through the same network rules as the API, `marketplaces.*`), prints
 * the review (source, digest, provenance, extension permissions, skills, connector templates,
 * dependencies) and, after `--yes` or an interactive yes, confirms it.
 * `--deploy-extension` also installs and enables the plugin's extension on the deployment. Acts as the
 * CLI operator (no account, like `capybara extensions install`). Exit code: 0 / 1 (failure, not
 * confirmed, or the extension deploy failed).
 */
export async function runPluginsImport(
  opts: { target: string; yes?: boolean; deployExtension?: boolean },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCatalog(log, env, async (cli) => {
      const t = parsePluginsImportTarget(opts.target);
      const prepared =
        t.kind === "file"
          ? await cli.imports.prepare(null, new Uint8Array(await readFile(t.path)), {
              kind: "file",
              ref: "upload",
            })
          : t.kind === "git"
            ? await cli.catalog.importFromGit(null, {
                url: t.url,
                ...(t.ref !== undefined && { ref: t.ref }),
                ...(t.path !== undefined && { path: t.path }),
              })
            : await cli.imports.prepareNpm(null, {
                package: t.package,
                ...(t.version !== undefined && { version: t.version }),
              });
      io.stdout.write(`${describeReview(prepared.review).join("\n")}\n`);
      if (!opts.yes) {
        io.stdout.write(`Import ${prepared.review.name} ${prepared.review.version}? [y/N] `);
        const answer = (await readLine(io.stdin))?.trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout.write(
            "\nNot imported (the review is kept for 24 hours; nothing else changed).\n",
          );
          return 1;
        }
      }
      const { item, deploy } = await cli.imports.confirm(null, prepared.stagingId, {
        reviewHash: prepared.review.reviewHash,
        deployExtension: opts.deployExtension === true,
      });
      io.stdout.write(`Imported ${item.name} ${item.latestVersion} into the catalog.\n`);
      if (deploy === null) return 0;
      if (deploy.result === "enabled") {
        await cli.publishChanged(deploy.name);
        io.stdout.write(`Extension ${deploy.name} ${deploy.version} installed and enabled.\n`);
        return 0;
      }
      io.stderr.write(
        `capybara: plugins import: the plugin is in the catalog but its extension was not deployed (${deploy.code}: ${deploy.message}); retry with: capybara extensions install ${opts.target}, then run: capybara extensions enable ${deploy.name} (a new install starts disabled)\n`,
      );
      return 1;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins import failed: ${errMsg(e)}\n`);
    return 1;
  }
}
