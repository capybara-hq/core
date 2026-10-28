import { readFile } from "node:fs/promises";
import type { BootstrapManifest } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** A compose `build:` / `build.context:` that is a git URL of the official plugins repository. */
export interface ComposeGitContext {
  file: string;
  /** 1-based line of the build context in `file`. */
  line: number;
  /** The repository URL as written (before `#`). */
  url: string;
  /** The ref after `#` (undefined: the default branch). */
  ref?: string;
  /** The directory after `#<ref>:` (undefined: the repository root). */
  dir?: string;
}

/** A repository URL compared loosely: no trailing slash, no `.git`, lower case. */
const normalized = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();

/**
 * The git build contexts of `repoUrls` in a compose file: lines `build: <url>` or
 * `context: <url>` (quoted or not, an optional trailing YAML comment). A small text scan instead of
 * a YAML parser: the compose files are ours and keep this shape; a `#` right after the URL is the
 * git fragment (`#<ref>:<dir>`), a YAML comment needs a space before it.
 */
export async function composeGitContexts(
  file: string,
  repoUrls: string[],
): Promise<ComposeGitContext[]> {
  const wanted = new Set(repoUrls.map(normalized));
  const out: ComposeGitContext[] = [];
  for (const [i, text] of (await readFile(file, "utf8")).split("\n").entries()) {
    const m = /^\s*(?:build|context):\s*(["']?)([^\s"']+)\1\s*(?:#.*)?$/.exec(text);
    const value = m?.[2];
    if (value === undefined || !/^(?:https?|git|ssh):\/\//.test(value)) continue;
    const hash = value.indexOf("#");
    const url = hash < 0 ? value : value.slice(0, hash);
    if (!wanted.has(normalized(url))) continue;
    const fragment = hash < 0 ? "" : value.slice(hash + 1);
    const colon = fragment.indexOf(":");
    const ref = colon < 0 ? fragment : fragment.slice(0, colon);
    const dir = colon < 0 ? "" : fragment.slice(colon + 1).replace(/^\.?\/+|\/+$/g, "");
    out.push({
      file,
      line: i + 1,
      url,
      ...(ref !== "" && { ref }),
      ...(dir !== "" && { dir }),
    });
  }
  return out;
}

/**
 * Rule `bootstrap-compose-ref` (offline): a compose file that builds an image from the official
 * plugins repository (the sandbox-docker images) must pin it to `marketplace.commit` of the
 * bootstrap manifest (`<url>#<commit>:<dir>`), so one commit pins everything core takes from that
 * repository. A context on a branch, a tag, the default branch or another commit is reported, and
 * so is one when the manifest has no marketplace commit.
 */
export function checkComposeRefs(
  contexts: ComposeGitContext[],
  manifest: BootstrapManifest,
): Finding[] {
  const commit = manifest.marketplace?.commit;
  return contexts.flatMap((c): Finding[] => {
    if (commit !== undefined && c.ref === commit) return [];
    const where = `${c.dir ?? "the repository root"} from ${c.url}`;
    return [
      {
        file: c.file,
        line: c.line,
        rule: "bootstrap-compose-ref",
        message:
          commit === undefined
            ? `builds ${where}, but packages/kernel/bootstrap.json has no marketplace commit to pin it to`
            : `builds ${where} at ${c.ref ?? "the default branch"}; pin it to marketplace.commit: ${c.url}#${commit}${c.dir === undefined ? "" : `:${c.dir}`}`,
      },
    ];
  });
}
