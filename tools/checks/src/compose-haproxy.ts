import { readFileSync } from "node:fs";
import type { Finding } from "./source.js";

/** Name of the compose config that inlines the sandbox-proxy haproxy config. */
export const COMPOSE_HAPROXY_CONFIG = "sandbox-proxy-haproxy";

/** Lines that matter to haproxy: no comments, no blank lines, no trailing whitespace. */
function significant(lines: { text: string; line: number }[]): { text: string; line: number }[] {
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+$/, "") }))
    .filter((l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"));
}

/**
 * Finds `configs.<name>.content: |` in a compose file and returns its lines (indentation of the
 * block removed) with their 1-based line numbers, or undefined when the block is missing. A small
 * text scan instead of a YAML parser: compose.yaml is ours and keeps this exact shape.
 */
function inlineBlock(
  text: string,
  name: string,
): { start: number; lines: { text: string; line: number }[] } | undefined {
  const all = text.split("\n");
  const keyAt = all.indexOf(`  ${name}:`);
  if (keyAt < 0) return undefined;
  const contentAt = keyAt + 1;
  if (!/^ {4}content: \|$/.test(all[contentAt] ?? "")) return undefined;
  const lines: { text: string; line: number }[] = [];
  let indent: number | undefined;
  for (let i = contentAt + 1; i < all.length; i++) {
    const l = all[i] as string;
    if (l.trim() === "") {
      lines.push({ text: "", line: i + 1 });
      continue;
    }
    const lead = l.length - l.trimStart().length;
    indent ??= lead;
    if (lead < indent || indent <= 4) break;
    lines.push({ text: l.slice(indent), line: i + 1 });
  }
  return { start: keyAt + 1, lines };
}

/**
 * The haproxy config of the compose sandbox profile is inlined in compose.yaml (a clean host has
 * only that file) and must stay identical, comments aside, to docker/sandbox-proxy/haproxy.cfg
 * (used by compose.dev.yaml). In compose content a literal "$" is written "$$"; a single "$"
 * would be interpolated by compose.
 */
export function checkComposeHaproxy(composeFile: string, cfgFile: string): Finding[] {
  const block = inlineBlock(readFileSync(composeFile, "utf8"), COMPOSE_HAPROXY_CONFIG);
  if (!block) {
    return [
      {
        file: composeFile,
        line: 1,
        rule: "compose-haproxy-missing",
        message: `configs.${COMPOSE_HAPROXY_CONFIG}.content (a "|" block) not found`,
      },
    ];
  }
  const findings: Finding[] = [];
  for (const l of block.lines) {
    if (l.text.replaceAll("$$", "").includes("$")) {
      findings.push({
        file: composeFile,
        line: l.line,
        rule: "compose-haproxy-dollar",
        message: 'unescaped "$": write "$$" in compose content (compose interpolates "$")',
      });
    }
  }
  const inline = significant(block.lines).map((l) => ({
    ...l,
    text: l.text.replaceAll("$$", "$"),
  }));
  const cfg = significant(
    readFileSync(cfgFile, "utf8")
      .split("\n")
      .map((text, i) => ({ text, line: i + 1 })),
  );
  const n = Math.max(inline.length, cfg.length);
  for (let i = 0; i < n; i++) {
    const a = inline[i];
    const b = cfg[i];
    if (a?.text === b?.text) continue;
    findings.push({
      file: composeFile,
      line: a?.line ?? block.start,
      rule: "compose-haproxy-drift",
      message: `differs from ${cfgFile.split("/").slice(-2).join("/")}:${b?.line ?? "end"}: expected ${JSON.stringify(b?.text ?? "<end of file>")}, got ${JSON.stringify(a?.text ?? "<end of block>")}; copy the file's non-comment lines (with "$" as "$$")`,
    });
    break;
  }
  return findings;
}

/** The sandbox-docker plugin's test copy of the socket proxy config (repo-relative). */
export const PLUGIN_HAPROXY_COPY = "plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg";

/**
 * The sandbox-docker plugin's tests start the socket proxy from their own copy of
 * docker/sandbox-proxy/haproxy.cfg (a plugin test reaches nothing in core, so the tests keep
 * working in the plugins repository); the copy must stay byte-identical to the file.
 */
export function checkHaproxyCopy(cfgFile: string, copyFile: string): Finding[] {
  let copy: string | undefined;
  try {
    copy = readFileSync(copyFile, "utf8");
  } catch {
    copy = undefined;
  }
  if (copy === readFileSync(cfgFile, "utf8")) return [];
  return [
    {
      file: copyFile,
      line: 1,
      rule: "compose-haproxy-copy",
      message: `${copy === undefined ? "missing" : "differs"}: must be an exact copy of ${cfgFile.split("/").slice(-2).join("/")} (cp it over)`,
    },
  ];
}
