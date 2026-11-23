import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema } from "@capybara-hq/plugin-sdk";
import { extensionConfigSchemas } from "../pack/config-schemas.js";
import { importPluginExtension } from "../pack/pack.js";
import { findCtxCalls, propName, unwrap } from "./plugin-permissions.js";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
} from "./source.js";

/** Extension points whose calls carry the org's effective config (unified config spec §5.3). */
const ORG_BOUND_POINTS = [
  "model-provider",
  "web-search",
  "web-fetch",
  "directory",
  "file-preview",
] as const;

/** A string field whose key says it holds a URL. */
const URL_NAME = /(url|uri|endpoint|host)$/i;

const SDK = "@capybara-hq/plugin-sdk";
const ROUTER = "configUrlFetch";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A field of an overridable top-level key: its display path and the property name it ends in. */
interface Field {
  /** The top-level key it belongs to. */
  key: string;
  /** `endpoints[].baseUrl`, `headers.*`. */
  path: string;
  /** The last property name on the path (a field's own name, an array item's array name). */
  leaf: string;
}

/** The node and its `anyOf` / `oneOf` / `allOf` branches, recursively (one value, many shapes). */
function shapes(node: Record<string, unknown>): Record<string, unknown>[] {
  const out = [node];
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    const list = node[k];
    if (Array.isArray(list)) for (const b of list) if (isObj(b)) out.push(...shapes(b));
  }
  return out;
}

/** The URL fields (`format: "uri"`) and the URL-named strings without it under one top-level key. */
function classifyKey(key: string, node: unknown, urls: Field[], named: Field[]): void {
  const visit = (n: unknown, path: string, leaf: string, isProperty: boolean): void => {
    if (!isObj(n)) return;
    const all = shapes(n);
    if (all.some((s) => s.format === "uri")) urls.push({ key, path, leaf });
    else if (isProperty && URL_NAME.test(leaf) && all.some((s) => s.type === "string")) {
      named.push({ key, path, leaf });
    }
    for (const s of all) {
      if (isObj(s.properties)) {
        for (const [k, child] of Object.entries(s.properties))
          visit(child, `${path}.${k}`, k, true);
      }
      const items = s.items;
      for (const item of Array.isArray(items) ? items : [items]) {
        visit(item, `${path}[]`, leaf, false);
      }
      visit(s.additionalProperties, `${path}.*`, leaf, false);
    }
  };
  visit(node, key, key, true);
}

/** The top-level keys an org may override: every key, unless the root or the key is platform-only. */
function overridableKeys(schema: JsonSchema | undefined): [string, unknown][] {
  if (schema === undefined || schema["x-platform-only"] === true) return [];
  const props = schema.properties;
  if (!isObj(props)) return [];
  return Object.entries(props).filter(([, v]) => !(isObj(v) && v["x-platform-only"] === true));
}

/** Every identifier and string literal in an expression: what a `url` argument may read. */
function namesIn(expr: Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (!isObj(n) || typeof n.type !== "string") return;
    if (n.type === "Identifier" && typeof n.name === "string") out.add(n.name);
    if (n.type === "Literal" && typeof n.value === "string") out.add(n.value);
    for (const [k, v] of Object.entries(n)) if (k !== "type" && typeof v === "object") visit(v);
  };
  visit(expr);
  return out;
}

/**
 * The names the `url` argument of every `configUrlFetch(net, { url, … })` call reads, where
 * `configUrlFetch` is imported from the SDK (named, renamed or through a namespace import).
 */
function routedNames(files: ParsedFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const locals = new Set<string>();
    const namespaces = new Set<string>();
    for (const stmt of f.program.body as Node[]) {
      if (stmt.type !== "ImportDeclaration" || (stmt.source as Node).value !== SDK) continue;
      for (const s of stmt.specifiers as Node[]) {
        const local = (s.local as Node).name as string;
        if (s.type === "ImportNamespaceSpecifier") namespaces.add(local);
        else if (s.type === "ImportSpecifier") {
          const imported = s.imported as Node;
          const name = imported.type === "Identifier" ? imported.name : imported.value;
          if (name === ROUTER) locals.add(local);
        }
      }
    }
    if (locals.size === 0 && namespaces.size === 0) continue;
    const isRouter = (callee: Node): boolean => {
      const c = unwrap(callee);
      if (c.type === "Identifier") return locals.has(c.name as string);
      if (c.type !== "MemberExpression") return false;
      const obj = unwrap(c.object as Node);
      const p = c.property as Node;
      const name = c.computed ? p.value : p.name;
      return obj.type === "Identifier" && namespaces.has(obj.name as string) && name === ROUTER;
    };
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const x of n) visit(x);
        return;
      }
      if (!isObj(n) || typeof n.type !== "string") return;
      const node = n as Node;
      if (node.type === "CallExpression" && isRouter(node.callee as Node)) {
        const arg = (node.arguments as Node[])[1];
        const opts = arg === undefined ? undefined : unwrap(arg);
        if (opts?.type === "ObjectExpression") {
          for (const p of opts.properties as Node[]) {
            if (propName(p) === "url") for (const name of namesIn(p.value as Node)) out.add(name);
          }
        }
      }
      for (const [k, v] of Object.entries(node))
        if (k !== "type" && typeof v === "object") visit(v);
    };
    visit(f.program);
  }
  return out;
}

/**
 * Where a field is declared: the object property named after it whose value is a call (a zod
 * chain such as `z.url()` or `ui(z.url(), …)`), preferring one nested under a property named after
 * the field's parent on the path. Falls back to line 1 of `fallback`.
 */
function declaration(files: ParsedFile[], field: Field, fallback: string): [string, number] {
  const segs = field.path.split(/\.|\[\]/).filter((s) => s !== "" && s !== "*");
  const parent = segs.length > 1 ? segs[segs.length - 2] : undefined;
  let first: [string, number] | undefined;
  for (const f of files) {
    let found: [string, number] | undefined;
    const visit = (n: unknown, ancestors: string[]): void => {
      if (found !== undefined) return;
      if (Array.isArray(n)) {
        for (const x of n) visit(x, ancestors);
        return;
      }
      if (!isObj(n) || typeof n.type !== "string") return;
      const node = n as Node;
      const name = node.type === "Property" ? propName(node) : undefined;
      if (name === field.leaf && unwrap(node.value as Node).type === "CallExpression") {
        const at: [string, number] = [f.file, f.lineOf(node.start)];
        first ??= at;
        if (parent === undefined || ancestors.includes(parent)) {
          found = at;
          return;
        }
      }
      const next = name === undefined ? ancestors : [...ancestors, name];
      for (const [k, v] of Object.entries(node))
        if (k !== "type" && typeof v === "object") visit(v, next);
    };
    visit(f.program, []);
    if (found !== undefined) return found;
  }
  return first ?? [fallback, 1];
}

/**
 * Config classification (unified plugin config spec §5.5). Every plugin with an extension
 * (`src/index.ts`) is bundled and imported the way the packer does; a deployment field is
 * overridable unless the root schema or its top-level key carries `"x-platform-only": true`
 * (`platformOnly`). Both rules are errors.
 *
 * - `plugin-config-unbound`: the extension has an overridable field but registers no tool
 *   (`ctx.tools.register`), no `ctx.ui` view or action and no hook, and provides none of
 *   `model-provider`, `web-search`, `web-fetch`, `directory` or `file-preview`. Only those entries
 *   carry an org's effective config, so the org's value could never take effect: mark the fields
 *   `platformOnly`. The finding points at `src/index.ts`.
 * - `plugin-org-url-net`: every URL under an overridable key (JSON Schema `format: "uri"`, which
 *   `z.url()` and `.url()` emit, in nested properties, array items and record values) must reach
 *   the network through the SDK's `configUrlFetch`: some non-test source must call
 *   `configUrlFetch(net, { url: … })`, imported from `@capybara-hq/plugin-sdk`, whose `url`
 *   expression reads the field's leaf name (`config.baseUrl`, `config["baseUrl"]`, a destructured
 *   `baseUrl`). A second finding of the rule: an overridable string field whose name ends in
 *   `url`, `uri`, `endpoint` or `host` (any case) without `format: "uri"`, so a URL cannot dodge
 *   the rule by its type (declare it `z.url()` or mark it `platformOnly`). Findings point at the
 *   field's declaration (the property named after it whose value is a call), or `src/index.ts`.
 *
 * Known gaps (as `kc-global-fetch`), left to the reviewer:
 * - matching is by leaf name: a field read by one `configUrlFetch` call and also passed to the
 *   global `fetch` elsewhere is not seen, nor two fields that share a leaf name of which only one
 *   is routed;
 * - a host assembled from non-URL fields (a region enum, a regex-limited workspace label) is not a
 *   URL field, so the reviewer judges such hosts.
 *
 * A plugin that does not bundle or import is left to "Plugin pack", which reports it.
 */
export async function checkConfigClassification(pluginDirs: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    const index = join(dir, "src/index.ts");
    if (!existsSync(index)) continue;
    let ext: Awaited<ReturnType<typeof importPluginExtension>>;
    try {
      ext = await importPluginExtension(dir);
    } catch {
      continue;
    }
    const keys = overridableKeys(extensionConfigSchemas(ext.config).schemas.deployment);
    if (keys.length === 0) continue;

    const calls = findCtxCalls(dir);
    const provided = (ext.provides ?? []).map((p) => String(p).split("@")[0] ?? "");
    const bound =
      calls.tools ||
      calls.ui ||
      calls.hooks ||
      provided.some((p) => (ORG_BOUND_POINTS as readonly string[]).includes(p));
    if (!bound) {
      const names = keys.map(([k]) => k).join(", ");
      findings.push({
        file: index,
        line: 1,
        rule: "plugin-config-unbound",
        message: `deployment config field ${names} can be overridden by an org, but the extension registers no tool, ui view, action or hook and provides no org-bound extension point (${ORG_BOUND_POINTS.join(", ")}), so an org's value never reaches it: mark ${names} platformOnly (or the whole schema: platformOnly(z.object({ … })))`,
      });
    }

    const urls: Field[] = [];
    const named: Field[] = [];
    for (const [key, node] of keys) classifyKey(key, node, urls, named);
    if (urls.length === 0 && named.length === 0) continue;
    const files: ParsedFile[] = [];
    for (const { file, isTest } of listSourceFiles(dir)) {
      if (isTest) continue;
      const parsed = parseFile(file);
      if (!isParseError(parsed)) files.push(parsed);
    }
    const routed = routedNames(files);
    for (const u of urls) {
      if (routed.has(u.leaf)) continue;
      const [file, line] = declaration(files, u, index);
      findings.push({
        file,
        line,
        rule: "plugin-org-url-net",
        message: `overridable deployment config URL ${u.path} is not read by any ${ROUTER}(net, { url }) call from ${SDK}, so an org's value would reach the network unguarded: build the fetch with ${ROUTER}(ctx.net, { url: config.${u.leaf}, platform, orgId }), or mark ${u.key} platformOnly`,
      });
    }
    for (const n of named) {
      const [file, line] = declaration(files, n, index);
      findings.push({
        file,
        line,
        rule: "plugin-org-url-net",
        message: `overridable deployment config field ${n.path} is named like a URL but is not declared as one (format "uri"): declare it z.url() so it is checked to go through ${ROUTER}, or mark ${n.key} platformOnly`,
      });
    }
  }
  return findings;
}
