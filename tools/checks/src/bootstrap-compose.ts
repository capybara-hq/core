import { readFile } from "node:fs/promises";
import type { BootstrapManifest } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/** A compose build context that is not a local path (a git or other remote context). */
export interface ComposeRemoteContext {
  file: string;
  /** 1-based line of the build context in `file`. */
  line: number;
  /** The context as written (quotes removed). */
  value: string;
}

/** A remote build context in the one accepted form: the official repository at the pinned commit. */
export interface ComposeGitContext extends ComposeRemoteContext {
  /** The directory after `#<commit>:` (never empty). */
  dir: string;
}

/** A value that is not a local directory: a URL, an scp-style git remote or a scheme-less host. */
export const isRemoteContext = (v: string) =>
  v.includes("://") || v.startsWith("git@") || /^github\.com\//i.test(v);

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Every build context of a compose file that is not a local path: block form (`build: <value>`,
 * `context: <value>`, quoted or not, with an optional trailing YAML comment, which needs a space
 * before its `#`; a `#` right after a URL is the git fragment) and flow form
 * (`build: { context: <value>, ... }`). A small text scan instead of a YAML parser: the compose
 * files are ours and keep these shapes.
 */
export async function composeRemoteContexts(file: string): Promise<ComposeRemoteContext[]> {
  const out: ComposeRemoteContext[] = [];
  for (const [i, text] of (await readFile(file, "utf8")).split("\n").entries()) {
    const m = /^\s*(?:-\s*)?(?:build|context):\s*(.*)$/.exec(text);
    if (m?.[1] === undefined) continue;
    let rest = m[1].trim();
    if (rest.startsWith("{")) {
      const flow = /\bcontext:\s*("[^"]*"|'[^']*'|[^,}\s]+)/.exec(rest);
      if (flow?.[1] === undefined) continue;
      rest = flow[1];
    } else {
      rest = rest.replace(/\s+#.*$/, "");
    }
    const value = unquote(rest);
    if (value === "" || !isRemoteContext(value)) continue;
    out.push({ file, line: i + 1, value });
  }
  return out;
}

/**
 * Rule `bootstrap-compose-ref` (offline): every remote build context of core's compose files (the
 * sandbox-docker images) must be exactly `<official url>#<marketplace.commit>:<dir>`, so one commit
 * of the official plugins repository pins everything core takes from it. Anything else is reported:
 * another repository or a fork, another URL form of the official one (scp-style, scheme-less,
 * http, without `.git`), a branch, a tag, the default branch, another commit, a `?ref=` query, no
 * directory, or a manifest without a marketplace commit. Returns the findings and the contexts that
 * pass (for the network half, which checks their Dockerfiles at the commit).
 */
export function checkComposeRefs(
  contexts: ComposeRemoteContext[],
  manifest: BootstrapManifest,
  officialUrl: string,
): { findings: Finding[]; pinned: ComposeGitContext[] } {
  const commit = manifest.marketplace?.commit;
  const findings: Finding[] = [];
  const pinned: ComposeGitContext[] = [];
  const prefix = `${officialUrl}#${commit}:`;
  for (const c of contexts) {
    const dir = c.value.slice(prefix.length);
    if (
      commit !== undefined &&
      c.value.startsWith(prefix) &&
      /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(dir) &&
      !dir.split("/").includes("..")
    ) {
      pinned.push({ ...c, dir });
      continue;
    }
    findings.push({
      file: c.file,
      line: c.line,
      rule: "bootstrap-compose-ref",
      message:
        commit === undefined
          ? `builds from ${c.value}, but packages/kernel/bootstrap.json has no marketplace commit to pin it to`
          : `builds from ${c.value}; a remote build context must be ${officialUrl}#${commit}:<dir> (the official plugins repository at marketplace.commit)`,
    });
  }
  return { findings, pinned };
}
