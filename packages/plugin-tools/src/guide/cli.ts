import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  renderSetupGuide,
  SETUP_GUIDE_PLACE_INFO,
  type SetupGuideAudience,
  type SetupGuideBlock,
  setupGuideDocPath,
  setupGuideDocProblem,
  validateSetupGuide,
} from "@capybara-hq/plugin-sdk";
import { readSourceManifest } from "../pack/pack.js";

export const GUIDE_USAGE =
  "capybara-plugin guide <id> [--locale en|zh] [--mode <mode>] [--audience <audience>] [--var <name>=<value>]...";

/** A fence of backticks longer than any run of backticks in `text`. */
const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const printBlock = (b: SetupGuideBlock): string => {
  switch (b.kind) {
    case "markdown":
      return b.text.replace(/\n+$/, "");
    case "code": {
      const fence = fenceFor(b.text);
      const title = b.title === null ? "" : ` title=${JSON.stringify(b.title)}`;
      return `${fence}${b.language}${title}\n${b.text}\n${fence}`;
    }
    case "check":
      return `[check ${b.id}] ${b.label}`;
  }
};

/**
 * `capybara-plugin guide <id>`: prints the setup guide `<id>` of the plugin in the current
 * directory rendered as the kernel would for one locale, mode and audience (spec
 * 2026-11-09-setup-guides-v2-design.md §4.5), so an author sees what an admin will see: the title,
 * each block (Markdown as is, code fenced with its title, a check as `[check <id>] <label>`), then
 * `unresolved: …` (the variables the text uses that got no `--var`, or `none`).
 *
 * - `--locale`: `en` (default) or `zh` (falls back to the English document when there is none);
 * - `--mode` / `--audience`: default the place's first mode (none when it has no modes) and first
 *   audience;
 * - `--var name=value`: a value for a variable of the place (repeatable); `{{mode}}` takes the
 *   mode rendered, as in the kernel, so `--var mode=…` is refused.
 *
 * The documents are validated first (without the extension's `permissions.setupChecks`, which
 * `pack` checks): errors are printed and exit 1, warnings are printed to stderr. Bad arguments exit 2.
 */
export async function guideCommand(args: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      locale: { type: "string" },
      mode: { type: "string" },
      audience: { type: "string" },
      var: { type: "string", multiple: true },
    },
  });
  if (values.help) {
    console.log(`usage: ${GUIDE_USAGE}`);
    return 0;
  }
  const [id, ...rest] = positionals;
  if (id === undefined || rest.length > 0) return usage("give one guide id");
  const locale = values.locale ?? "en";
  if (locale !== "en" && locale !== "zh") return usage(`--locale must be en or zh, not ${locale}`);

  const manifest = await readSourceManifest(cwd, cwd);
  const guides = manifest.setupGuides ?? [];
  const guide = guides.find((g) => g.id === id);
  if (guide === undefined) {
    const known = guides.map((g) => g.id).join(", ") || "none";
    return usage(`no setup guide "${id}" in plugin.json (guides: ${known})`);
  }
  const info = SETUP_GUIDE_PLACE_INFO[guide.place];
  const mode = values.mode ?? info.modes[0] ?? null;
  if (mode !== null && !info.modes.includes(mode)) {
    const allowed = info.modes.length === 0 ? "it has no modes" : info.modes.join(", ");
    return usage(`place ${guide.place} has no mode ${mode} (${allowed})`);
  }
  const audience = (values.audience ?? info.audiences[0]) as SetupGuideAudience;
  if (!info.audiences.includes(audience)) {
    return usage(`place ${guide.place} has no audience ${audience} (${info.audiences.join(", ")})`);
  }
  const vars: Record<string, string> = {};
  for (const v of values.var ?? []) {
    const eq = v.indexOf("=");
    if (eq <= 0) return usage(`--var takes name=value, not ${v}`);
    const name = v.slice(0, eq);
    if (name === "mode") return usage("--var mode is not accepted: give the mode with --mode");
    if (!Object.hasOwn(info.variables, name)) {
      return usage(
        `unknown variable ${name} for place ${guide.place} (known: ${Object.keys(info.variables).join(", ")})`,
      );
    }
    vars[name] = v.slice(eq + 1);
  }

  const docs: Partial<Record<"en" | "zh", string>> = {};
  for (const l of ["en", "zh"] as const) {
    const rel = setupGuideDocPath(id, l);
    const p = join(cwd, rel);
    if (!existsSync(p)) {
      if (l === "zh") continue;
      console.error(`${rel} does not exist (each guide needs its English document)`);
      return 1;
    }
    const data = await readFile(p);
    const problem = setupGuideDocProblem(rel, new Uint8Array(data));
    if (problem !== undefined) {
      console.error(problem);
      return 1;
    }
    docs[l] = data.toString("utf8");
  }
  const en = docs.en as string;
  const issues = validateSetupGuide({
    id,
    place: guide.place,
    en,
    ...(docs.zh !== undefined && { zh: docs.zh }),
  });
  const errors = issues.filter((i) => i.level === "error");
  for (const i of errors) console.error(i.message);
  if (errors.length > 0) return 1;
  for (const i of issues) console.error(`warning: ${i.message}`);

  const r = renderSetupGuide(docs[locale] ?? en, {
    place: guide.place,
    mode,
    audience,
    // `{{mode}}` is the mode rendered, as in the kernel's guide route
    values: { ...vars, mode },
  });
  const parts = [`# ${r.title}`, ...r.blocks.map(printBlock)];
  parts.push(`unresolved: ${r.unresolved.length > 0 ? r.unresolved.join(", ") : "none"}`);
  console.log(parts.join("\n\n"));
  return 0;
}

function usage(msg: string): number {
  console.error(`${msg}\nusage: ${GUIDE_USAGE}`);
  return 2;
}
