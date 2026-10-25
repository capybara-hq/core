import { readFile } from "node:fs/promises";
import { type KernelLogger, openCatalogCli, type PluginReview } from "@capybara-hq/kernel";
import { BUILTIN_PLUGINS } from "../builtin-plugins.js";
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
  fn: Parameters<typeof withOpened<Awaited<ReturnType<typeof openCatalogCli>>, T>>[3],
) =>
  withOpened(
    log,
    env,
    (config) => openCatalogCli(config, log, { builtin: [...BUILTIN_PLUGINS] }),
    fn,
  );

/** `capybara plugins list`: the catalog's items with their latest version, components and policy. */
export async function runPluginsList(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PluginsIo = defaultIo(),
): Promise<number> {
  try {
    return await withCatalog(log, env, async (cli) => {
      const items = await cli.catalog.list();
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

/** The review as printed before the confirmation: every component the admin confirms. */
export function describeReview(r: PluginReview): string[] {
  const out = [
    `${r.name} ${r.version} (${r.packageName}) by ${r.publisher}`,
    `  ${r.description}`,
    `  source: ${r.source.kind} ${r.source.ref}`,
  ];
  const e = r.extension;
  if (e) {
    out.push(
      `Extension ${e.name} ${e.version}: ${e.action === "install" ? "not installed on this deployment" : e.action === "upgrade" ? `installed at ${e.currentVersion}, replaced when deployed` : "this exact package is installed"}`,
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
  return out;
}

/**
 * `capybara plugins import <file.tgz | npm:<name>[@<ver>]> [--deploy-extension] [--yes]`: prepares the
 * import (reads and checks the whole package, stages it), prints the review (extension permissions,
 * skills, connector templates, dependencies) and, after `--yes` or an interactive yes, confirms it.
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
      const t = parseInstallTarget(opts.target);
      const prepared =
        t.kind === "file"
          ? await cli.imports.prepare(null, new Uint8Array(await readFile(t.path)), {
              kind: "file",
              ref: "upload",
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
        `capybara: plugins import: the plugin is in the catalog but its extension was not deployed (${deploy.code}: ${deploy.message}); retry with: capybara extensions install ${opts.target}\n`,
      );
      return 1;
    });
  } catch (e) {
    io.stderr.write(`capybara: plugins import failed: ${errMsg(e)}\n`);
    return 1;
  }
}
