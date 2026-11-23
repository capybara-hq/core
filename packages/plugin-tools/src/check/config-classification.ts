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
  stringValue,
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
/** An array or record of strings whose key says it holds URLs (plural allowed). */
const URLS_NAME = /(url|uri|endpoint|host)s?$/i;

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

type Schema = Record<string, unknown>;

/** The target of a local `$ref` (`#`, `#/$defs/X`, `#/definitions/X`, any JSON pointer). */
function deref(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = isObj(cur) ? cur[seg] : undefined;
  }
  return isObj(cur) ? cur : undefined;
}

/**
 * The shapes one value may take: the node, its `anyOf` / `oneOf` / `allOf` branches and the targets
 * of its local `$ref`s, recursively. `seen` holds the refs already followed on this path (cycles).
 */
function shapes(node: Schema, root: Schema, seen: Set<string>): Schema[] {
  const out = [node];
  if (typeof node.$ref === "string" && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    const target = deref(root, node.$ref);
    if (target !== undefined) out.push(...shapes(target, root, seen));
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    const list = node[k];
    if (Array.isArray(list)) for (const b of list) if (isObj(b)) out.push(...shapes(b, root, seen));
  }
  return out;
}

/** A plain string: `type: "string"` with no `format: "uri"`, `enum` or `const`. */
const plainString = (all: Schema[]) =>
  all.some((s) => s.type === "string") &&
  !all.some((s) => s.format === "uri" || s.enum !== undefined || s.const !== undefined);

/** The element schemas of an array or record shape (items, prefixItems, record values). */
function elements(s: Schema): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(s.items)) out.push(...s.items);
  else out.push(s.items);
  if (Array.isArray(s.prefixItems)) out.push(...s.prefixItems);
  out.push(s.additionalProperties);
  if (isObj(s.patternProperties)) out.push(...Object.values(s.patternProperties));
  return out.filter(isObj);
}

/**
 * The URL fields (`format: "uri"`) and the URL-named plain strings under one top-level key: a
 * string property named like a URL, or an array or record of plain strings named like URLs
 * (`mirrorUrls`, `hosts`). Walks nested properties, `items`, `prefixItems`, `additionalProperties`,
 * `patternProperties`, unions and local `$ref`s; `if` / `then` / `else` and `not` are not walked.
 */
function classifyKey(
  key: string,
  node: unknown,
  root: Schema,
  urls: Field[],
  named: Field[],
): void {
  const visit = (
    n: unknown,
    path: string,
    leaf: string,
    isProperty: boolean,
    seen: Set<string>,
  ): void => {
    if (!isObj(n)) return;
    const refs = new Set(seen);
    const all = shapes(n, root, refs);
    if (all.some((s) => s.format === "uri")) urls.push({ key, path, leaf });
    else if (isProperty) {
      const asString = URL_NAME.test(leaf) && plainString(all);
      const asList =
        URLS_NAME.test(leaf) &&
        all.some((s) =>
          elements(s).some((e) => plainString(shapes(e as Schema, root, new Set(refs)))),
        );
      if (asString || asList) named.push({ key, path, leaf });
    }
    for (const s of all) {
      if (isObj(s.properties)) {
        for (const [k, child] of Object.entries(s.properties)) {
          visit(child, `${path}.${k}`, k, true, refs);
        }
      }
      const items = [
        ...(Array.isArray(s.items) ? s.items : [s.items]),
        ...(Array.isArray(s.prefixItems) ? s.prefixItems : []),
      ];
      for (const item of items) visit(item, `${path}[]`, leaf, false, refs);
      const values = [
        s.additionalProperties,
        ...(isObj(s.patternProperties) ? Object.values(s.patternProperties) : []),
      ];
      for (const value of values) visit(value, `${path}.*`, leaf, false, refs);
    }
  };
  visit(node, key, key, true, new Set());
}

/** The top-level keys an org may override: every key, unless the root or the key is platform-only. */
function overridableKeys(schema: JsonSchema | undefined): [string, unknown][] {
  if (schema === undefined || schema["x-platform-only"] === true) return [];
  const props = schema.properties;
  if (!isObj(props)) return [];
  return Object.entries(props).filter(([, v]) => !(isObj(v) && v["x-platform-only"] === true));
}

/**
 * The field names a `url` argument reads: a bare identifier (`url: baseUrl`, also one bound by
 * destructuring), the last property of a member chain rooted in an identifier (`config.baseUrl`,
 * `opts.config["baseUrl"]`), through `??` / `||`, `? :`, `+` and template literals. A name inside a
 * call or `new` (`new URL(c.baseUrl).origin`), a callee and an intermediate member never count.
 */
function namesIn(expr: Node, out = new Set<string>()): Set<string> {
  const e = unwrap(expr);
  switch (e.type) {
    case "Identifier":
      out.add(e.name as string);
      break;
    case "MemberExpression": {
      let obj = unwrap(e.object as Node);
      while (obj.type === "MemberExpression") obj = unwrap(obj.object as Node);
      const p = e.property as Node;
      const name = e.computed ? stringValue(p) : p.type === "Identifier" ? p.name : undefined;
      if (
        (obj.type === "Identifier" || obj.type === "ThisExpression") &&
        typeof name === "string"
      ) {
        out.add(name);
      }
      break;
    }
    case "LogicalExpression":
    case "BinaryExpression":
      namesIn(e.left as Node, out);
      namesIn(e.right as Node, out);
      break;
    case "ConditionalExpression":
      namesIn(e.consequent as Node, out);
      namesIn(e.alternate as Node, out);
      break;
    case "TemplateLiteral":
      for (const x of e.expressions as Node[]) namesIn(x, out);
      break;
  }
  return out;
}

const WRAPPER_TYPES = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/**
 * Whether a call's result is used: not a bare expression statement, not `void`, not a non-last
 * element of a comma sequence (`ancestors`: the call's ancestors, innermost last).
 */
function resultUsed(call: Node, ancestors: Node[]): boolean {
  let child = call;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i] as Node;
    if (WRAPPER_TYPES.has(a.type)) {
      child = a;
      continue;
    }
    if (a.type === "ExpressionStatement") return false;
    if (a.type === "UnaryExpression" && a.operator === "void") return false;
    if (a.type === "SequenceExpression") {
      const list = a.expressions as Node[];
      if (list[list.length - 1] !== child) return false;
      child = a;
      continue;
    }
    return true;
  }
  return true;
}

/**
 * The names the `url` argument of every used `configUrlFetch(net, { url, … })` call reads, where
 * `configUrlFetch` is imported from the SDK (named, renamed or through a namespace import); a
 * call whose result is dropped routes nothing.
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
      const name = c.computed ? stringValue(p) : p.name;
      return obj.type === "Identifier" && namespaces.has(obj.name as string) && name === ROUTER;
    };
    const ancestors: Node[] = [];
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const x of n) visit(x);
        return;
      }
      if (!isObj(n) || typeof n.type !== "string") return;
      const node = n as Node;
      if (
        node.type === "CallExpression" &&
        isRouter(node.callee as Node) &&
        resultUsed(node, ancestors)
      ) {
        const arg = (node.arguments as Node[])[1];
        const opts = arg === undefined ? undefined : unwrap(arg);
        if (opts?.type === "ObjectExpression") {
          for (const p of opts.properties as Node[]) {
            if (propName(p) === "url") namesIn(p.value as Node, out);
          }
        }
      }
      ancestors.push(node);
      for (const [k, v] of Object.entries(node)) {
        if (k !== "type" && typeof v === "object") visit(v);
      }
      ancestors.pop();
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
 *   `z.url()` and `.url()` emit, in nested properties, array items and tuple elements, record
 *   values and pattern properties, unions and local `$ref`s) must reach the network through the
 *   SDK's `configUrlFetch`: some non-test source must call `configUrlFetch(net, { url: … })`,
 *   imported from `@capybara-hq/plugin-sdk` (named, renamed or through a namespace import), and use
 *   the result (not a bare statement), with a `url` expression that reads the field's leaf name
 *   (`config.baseUrl`, `config["baseUrl"]`, a destructured `baseUrl`; see {@link namesIn}). A
 *   second finding of the rule: an overridable plain string field (no `format: "uri"`, `enum` or
 *   `const`) whose name ends in `url`, `uri`, `endpoint` or `host` (any case), or an array or
 *   record of plain strings whose name ends in one of them or its plural, so a URL cannot dodge
 *   the rule by its type (declare it `z.url()` or mark it `platformOnly`). Findings point at the
 *   field's declaration (the property named after it whose value is a call), or `src/index.ts`.
 *
 * Known gaps (as `kc-global-fetch`), left to the reviewer:
 * - matching is by leaf name: a field read by one `configUrlFetch` call and also passed to the
 *   global `fetch` elsewhere is not seen, nor two fields that share a leaf name of which only one
 *   is routed;
 * - the call's result being used is not proof it reaches the vendor SDK (assigned and never passed
 *   on is not seen);
 * - JSON Schema `if` / `then` / `else` and `not` are not walked, and remote `$ref`s are not
 *   followed (zod emits neither for a config schema);
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
    const schema = extensionConfigSchemas(ext.config).schemas.deployment;
    const keys = overridableKeys(schema);
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
    for (const [key, node] of keys) classifyKey(key, node, schema as Schema, urls, named);
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
