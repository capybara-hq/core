import { parse as parseYaml } from "yaml";

/**
 * Reads a Markdown file that starts with YAML frontmatter between `---` lines (SKILL.md, agent
 * templates): the frontmatter mapping and the body after it. Tolerates a BOM and CRLF (CRLF in the
 * body becomes LF). `file` names the file in the errors (English); frontmatter longer than
 * `maxChars` is not parsed. Not exported from the package.
 */
export function readFrontmatter(
  text: string,
  file: string,
  maxChars: number,
): { frontmatter: Record<string, unknown>; body: string } | { errors: string[] } {
  const src = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { errors: [`${file} must start with YAML frontmatter delimited by '---' lines`] };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { errors: [`${file} frontmatter is not closed by a '---' line`] };
  const front = lines.slice(1, end).join("\n");
  if (front.length > maxChars) {
    return {
      errors: [`frontmatter must be at most ${maxChars} characters`],
    };
  }
  const body = lines.slice(end + 1).join("\n");
  let data: unknown;
  try {
    data = parseYaml(front, { uniqueKeys: true, maxAliasCount: 50 });
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { errors: [`frontmatter is not valid YAML: ${first}`] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["frontmatter must be a YAML mapping"] };
  }
  return { frontmatter: data as Record<string, unknown>, body };
}
