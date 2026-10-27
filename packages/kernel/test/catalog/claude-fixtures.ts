import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directory of the Claude Code plugin fixtures (`superpowers`, `mixed`, `root-skill`, `commands-demo`). */
export const CLAUDE_FIXTURES = join(import.meta.dirname, "fixtures", "claude");

const walk = (dir: string, root: string, out: Map<string, Uint8Array>) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile()) out.set(relative(root, p).split(sep).join("/"), readFileSync(p));
  }
};

/** Every file of a fixture directory, keyed by its `/`-separated path relative to it. */
export function loadFixture(name: string): Map<string, Uint8Array> {
  const root = join(CLAUDE_FIXTURES, name);
  const out = new Map<string, Uint8Array>();
  walk(root, root, out);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** {@link loadFixture} as UTF-8 strings (for `fakeGit.commit`). */
export function loadFixtureAsStrings(name: string): Record<string, string> {
  return Object.fromEntries(
    [...loadFixture(name)].map(([p, d]) => [p, Buffer.from(d).toString("utf8")]),
  );
}

/** A copy of `files` with some entries set (string or JSON value) or removed (`null`). */
export function withFiles(
  files: ReadonlyMap<string, Uint8Array>,
  changes: Record<string, string | object | null>,
): Map<string, Uint8Array> {
  const out = new Map(files);
  for (const [p, v] of Object.entries(changes)) {
    if (v === null) out.delete(p);
    else out.set(p, Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));
  }
  return out;
}
