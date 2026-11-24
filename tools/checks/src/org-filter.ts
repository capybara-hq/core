import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
  stringValue,
  walk,
} from "./source.js";

/**
 * Tenant filter check (issue #115): a kernel query on a table that has an `org_id` column filters
 * by it, or says why it need not.
 *
 * The org-scoped tables are read from the Kysely schema (`packages/kernel/src/db/kernel-schema.ts`):
 * every `KernelDatabase` member whose row interface (followed through local `extends`) declares
 * `org_id`. A query is a `selectFrom` / `updateTable` / `deleteFrom` / `mergeInto` call naming
 * one of them (also `"t as a"` and arrays), or a `sql` template whose text reads or writes one
 * (`from t`, `join t`, `update t`, `delete from t`). It passes when `org_id` (a word, so
 * `c.org_id` counts and `owner_org_id` does not) appears in a filter of its chain (`where`,
 * `whereRef`, `having`, `on`, `onRef`, the joins, `$if`, `$call`; a subquery inside one is
 * followed, which covers "join through an org-scoped table"), in the `sql` text, or in a later
 * `.where…(…org_id…)` on the variable the query is assigned to in the same function. Inserts are
 * not checked: they write the row's own org, and the RLS spec's `WITH CHECK` is their backstop.
 *
 * Otherwise the query carries an exemption: a line comment `// org-filter: <reason>` on the line
 * just above a statement, declaration, method or class that contains it (above its decorators or
 * between them and the declaration; one marker may cover a whole method or class, e.g. a
 * super-admin service), with a reason of at least {@link MIN_REASON} characters. A marker above a
 * nested expression (an arrow body, a `.with(…)` argument) covers nothing: put it above the
 * enclosing statement. Rules:
 *
 * - `org-filter`: a query on an org-scoped table with no org filter and no exemption;
 * - `org-filter-reason`: an exemption without a reason;
 * - `org-filter-stale`: an exemption that covers no unfiltered org-scoped query (the query gained
 *   a filter or moved), so markers cannot pile up;
 * - `org-filter-schema`: the schema could not be read (no `KernelDatabase`, or a member whose row
 *   type is not a local interface), so the check cannot know the tables;
 * - `org-filter-platform` (RLS spec §10, decision 7): a query covered by a marker whose reason says
 *   "deployment-wide" is not inside an `asPlatform(…)` call (in one of its arguments), so once RLS
 *   is enforced it would see only the rows of whatever scope its caller had;
 * - `org-filter-policy` (RLS spec §7, phase 3): an org-scoped table without a row level security
 *   policy in the kernel migrations (`packages/kernel/src/migrations/*.sql`): each needs a `CREATE
 *   POLICY … ON <table>`, in the migration that adds the table or a later one (SQL comments do not
 *   count). Enabling RLS is not required: the policies ship dark and phase 5 enables them (spec
 *   §10, maintainer decision 2026-11-24).
 *
 * Limits (heuristic, text-based like the other checks): an org filter added through a helper
 * whose call does not mention `org_id` is not seen (exempt it, naming the helper); a query built
 * from a table name held in a variable is not seen; `org_id` in a filter is enough, the value
 * compared is not checked; only the table a query starts from is checked, so an org-scoped table
 * joined onto a table without `org_id` is not seen; `org_id` on a joined table (`whereRef("a.org_id",
 * "=", "c.org_id")`) satisfies the whole chain. Runs over every non-test file of
 * `packages/kernel/src`.
 */
export const ORG_FILTER_RULES = [
  "org-filter",
  "org-filter-reason",
  "org-filter-stale",
  "org-filter-schema",
  "org-filter-platform",
  "org-filter-policy",
] as const;

export const MIN_REASON = 12;
const MARKER = /^\s*org-filter:\s*(.*)$/;
const SCHEMA = "packages/kernel/src/db/kernel-schema.ts";
const KERNEL_SRC = "packages/kernel/src";
const MIGRATIONS = "packages/kernel/src/migrations";
const DEPLOYMENT_WIDE = /\bdeployment[- ]wide\b/i;

const QUERY_METHODS = new Set(["selectFrom", "updateTable", "deleteFrom", "mergeInto"]);
const FILTER_METHODS = new Set([
  "where",
  "whereRef",
  "having",
  "on",
  "onRef",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "innerJoinLateral",
  "leftJoinLateral",
  "using",
  "$if",
  "$call",
]);
const ORG_ID = /\borg_id\b/;
const SCOPE_TYPES = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "ClassDeclaration",
  "FunctionDeclaration",
  "VariableDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
]);

/** The tables of `KernelDatabase` whose row type has an `org_id` column, or a schema finding. */
export function orgScopedTables(root: string): Set<string> | Finding {
  const file = join(root, SCHEMA);
  const parsed = parseFile(file);
  if (isParseError(parsed)) return { ...parsed, rule: "org-filter-schema" };
  const interfaces = new Map<string, Node>();
  walk(parsed.program, (n) => {
    if (n.type === "TSInterfaceDeclaration") interfaces.set((n.id as Node).name as string, n);
  });
  const fieldsOf = (name: string, seen = new Set<string>()): Set<string> | undefined => {
    const decl = interfaces.get(name);
    if (!decl || seen.has(name)) return decl ? new Set() : undefined;
    seen.add(name);
    const out = new Set<string>();
    for (const m of ((decl.body as Node).body as Node[]) ?? []) {
      if (m.type === "TSPropertySignature") {
        const key = m.key as Node;
        const k = key.type === "Identifier" ? (key.name as string) : stringValue(key);
        if (k) out.add(k);
      }
    }
    for (const h of (decl.extends as Node[] | undefined) ?? []) {
      const e = h.expression as Node;
      if (e.type !== "Identifier") continue;
      for (const f of fieldsOf(e.name as string, seen) ?? []) out.add(f);
    }
    return out;
  };
  const db = interfaces.get("KernelDatabase");
  if (!db) {
    return {
      file,
      line: 1,
      rule: "org-filter-schema",
      message: "no `interface KernelDatabase` found: the org-scoped tables are unknown",
    };
  }
  const tables = new Set<string>();
  for (const m of (db.body as Node).body as Node[]) {
    if (m.type !== "TSPropertySignature") continue;
    const key = m.key as Node;
    const table = key.type === "Identifier" ? (key.name as string) : stringValue(key);
    const type =
      ((m.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined) ?? null;
    const typeName =
      type?.type === "TSTypeReference" && (type.typeName as Node).type === "Identifier"
        ? ((type.typeName as Node).name as string)
        : undefined;
    const fields = typeName ? fieldsOf(typeName) : undefined;
    if (!table || !fields) {
      return {
        file,
        line: parsed.lineOf(m.start),
        rule: "org-filter-schema",
        message: `KernelDatabase member ${table ?? "?"}: its row type is not a local interface, so the check cannot tell whether it has org_id`,
      };
    }
    if (fields.has("org_id")) tables.add(table);
  }
  return tables;
}

interface Marker {
  /** Line of the first comment of the block. */
  line: number;
  /** Line of the last comment of the block. */
  endLine: number;
  reason: string;
  used: boolean;
}

/** Groups consecutive `//` comments into blocks and keeps the ones that hold the marker. */
function markersOf(p: ParsedFile): Marker[] {
  const out: Marker[] = [];
  let block: { line: number; endLine: number; texts: string[] } | null = null;
  const flush = () => {
    if (!block) return;
    const i = block.texts.findIndex((t) => MARKER.test(t));
    if (i >= 0) {
      const first = MARKER.exec(block.texts[i] as string)?.[1] ?? "";
      const reason = [first, ...block.texts.slice(i + 1)].join(" ").replace(/\s+/g, " ").trim();
      out.push({ line: block.line, endLine: block.endLine, reason, used: false });
    }
    block = null;
  };
  for (const c of p.comments) {
    if (c.type !== "Line") {
      flush();
      continue;
    }
    const line = p.lineOf(c.start);
    // only comments on their own line form a marker block; a trailing comment ends one
    if (!p.lineText(line).trimStart().startsWith("//")) {
      flush();
      continue;
    }
    if (block && line === block.endLine + 1) {
      block.endLine = line;
      block.texts.push(c.value);
    } else {
      flush();
      block = { line, endLine: line, texts: [c.value] };
    }
  }
  flush();
  return out;
}

const SQL_TABLE = /\b(?:from|join|update|into)\s+(?:capybara\.)?"?([a-z_][a-z0-9_]*)"?/gi;

function tableArg(arg: Node | undefined): string[] {
  if (!arg) return [];
  if (arg.type === "ArrayExpression") return (arg.elements as Node[]).flatMap((e) => tableArg(e));
  const v = stringValue(arg);
  if (v === undefined) return [];
  const name = v.trim().split(/\s+/)[0] ?? "";
  return [name.replace(/^capybara\./, "")];
}

function propName(m: Node): string | undefined {
  const p = m.property as Node;
  return p.type === "Identifier" && !m.computed ? (p.name as string) : undefined;
}

/** Checks one parsed kernel file. */
export function checkOrgFilterFile(p: ParsedFile, tables: Set<string>): Finding[] {
  const parents = new Map<Node, Node>();
  const queries: { node: Node; table: string }[] = [];
  walk(p.program, (n, parent) => {
    if (parent) parents.set(n, parent);
    if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      if (callee.type === "MemberExpression") {
        const name = propName(callee);
        if (name && QUERY_METHODS.has(name)) {
          const hit = tableArg((n.arguments as Node[])[0]).find((t) => tables.has(t));
          if (hit) queries.push({ node: n, table: hit });
        }
      }
    }
    if (n.type === "TaggedTemplateExpression") {
      const tag = n.tag as Node;
      if (tag.type === "Identifier" && tag.name === "sql") {
        const text = ((n.quasi as Node).quasis as Node[])
          .map((q) => (q.value as { raw: string }).raw)
          .join(" ");
        for (const m of text.matchAll(SQL_TABLE)) {
          const t = m[1]?.toLowerCase() ?? "";
          if (tables.has(t) && !/^\s*into\s/i.test(m[0])) {
            queries.push({ node: n, table: t });
            break;
          }
        }
      }
    }
  });

  const text = (n: Node) => p.source.slice(n.start, n.end);
  // the line of `.selectFrom(` (a chain often starts lines above it)
  const queryLine = (node: Node) =>
    p.lineOf(
      node.type === "CallExpression"
        ? (((node.callee as Node).property as Node).start as number)
        : node.start,
    );
  const findings: Finding[] = [];
  const markers = markersOf(p);

  const filtered = (q: Node): boolean => {
    if (q.type === "TaggedTemplateExpression") return ORG_ID.test(text(q));
    let cur = q;
    for (;;) {
      if (cur.type === "CallExpression") {
        const callee = cur.callee as Node;
        const name = callee.type === "MemberExpression" ? propName(callee) : undefined;
        if (name && FILTER_METHODS.has(name)) {
          if ((cur.arguments as Node[]).some((a) => ORG_ID.test(text(a)))) return true;
        }
      }
      const parent = parents.get(cur);
      if (!parent) break;
      if (parent.type === "MemberExpression" && parent.object === cur) {
        const gp = parents.get(parent);
        if (gp?.type === "CallExpression" && gp.callee === parent) {
          cur = gp;
          continue;
        }
        cur = parent;
        continue;
      }
      if (parent.type === "AwaitExpression" || parent.type === "TSAsExpression") {
        cur = parent;
        continue;
      }
      // the query held in a variable and filtered later in the same function: `q = q.where(…)`
      const variable =
        parent.type === "VariableDeclarator" && parent.init === cur
          ? (parent.id as Node)
          : parent.type === "AssignmentExpression" && parent.right === cur
            ? (parent.left as Node)
            : undefined;
      if (variable?.type === "Identifier") {
        return laterFilter(variable.name as string, cur);
      }
      break;
    }
    return false;
  };

  const laterFilter = (name: string, from: Node): boolean => {
    let fn: Node | undefined = parents.get(from);
    while (
      fn &&
      fn.type !== "FunctionDeclaration" &&
      fn.type !== "FunctionExpression" &&
      fn.type !== "ArrowFunctionExpression"
    ) {
      fn = parents.get(fn);
    }
    if (!fn) return false;
    let found = false;
    walk(fn.body, (n) => {
      if (found || n.type !== "CallExpression") return;
      const callee = n.callee as Node;
      if (callee.type !== "MemberExpression") return;
      const method = propName(callee);
      if (!method || !FILTER_METHODS.has(method)) return;
      let root = callee.object as Node;
      while (root.type === "CallExpression" || root.type === "MemberExpression") {
        root = (root.type === "CallExpression" ? root.callee : root.object) as Node;
      }
      if (root.type === "Identifier" && root.name === name) {
        if ((n.arguments as Node[]).some((a) => ORG_ID.test(text(a)))) found = true;
      }
    });
    return found;
  };

  const coveringMarker = (q: Node): Marker | undefined => {
    let cur: Node | undefined = q;
    while (cur) {
      if (SCOPE_TYPES.has(cur.type) || cur.type.endsWith("Statement")) {
        // above the declaration itself, or above its first decorator (`@Injectable()`)
        const decorators = (cur.decorators as Node[] | undefined) ?? [];
        const starts = [cur.start, ...decorators.map((d) => d.start)].map((s) => p.lineOf(s));
        const m = markers.find((x) => starts.includes(x.endLine + 1));
        if (m) return m;
      }
      cur = parents.get(cur);
    }
    return undefined;
  };

  /** Whether `q` sits in an argument of an `asPlatform(…)` call. */
  const inPlatform = (q: Node): boolean => {
    let child = q;
    let cur = parents.get(q);
    while (cur) {
      if (cur.type === "CallExpression" && cur.callee !== child) {
        const callee = cur.callee as Node;
        const name =
          callee.type === "Identifier"
            ? (callee.name as string)
            : callee.type === "MemberExpression"
              ? propName(callee)
              : undefined;
        if (name === "asPlatform") return true;
      }
      child = cur;
      cur = parents.get(cur);
    }
    return false;
  };

  for (const { node, table } of queries) {
    if (filtered(node)) continue;
    const marker = coveringMarker(node);
    if (marker) {
      marker.used = true;
      if (DEPLOYMENT_WIDE.test(marker.reason) && !inPlatform(node)) {
        findings.push({
          file: p.file,
          line: queryLine(node),
          rule: "org-filter-platform",
          message: `query on org-scoped table "${table}" is marked deployment-wide but runs outside asPlatform: wrap the deployment-wide part in asPlatform("<reason>", () => …) (RLS spec §10), or say in the marker why it is not deployment-wide`,
        });
      }
      continue;
    }
    findings.push({
      file: p.file,
      line: queryLine(node),
      rule: "org-filter",
      message: `query on org-scoped table "${table}" has no org_id filter: add .where("org_id", "=", orgId) (or join through an org-scoped table that is filtered), or put "// org-filter: <reason>" above the statement (deployment-wide read, super-admin route, job iterating orgs, already scoped by …)`,
    });
  }
  for (const m of markers) {
    if (m.reason.length < MIN_REASON) {
      findings.push({
        file: p.file,
        line: m.line,
        rule: "org-filter-reason",
        message: `"// org-filter:" needs a reason of at least ${MIN_REASON} characters saying why the query need not filter by org_id`,
      });
    } else if (!m.used) {
      findings.push({
        file: p.file,
        line: m.line,
        rule: "org-filter-stale",
        message:
          '"// org-filter:" covers no unfiltered query on an org-scoped table: remove it (or move it just above the statement that holds the query)',
      });
    }
  }
  return findings;
}

/** Runs the check over every non-test file of `packages/kernel/src` under `root`. */
export function checkOrgFilter(root: string): Finding[] {
  const tables = orgScopedTables(root);
  if (!(tables instanceof Set)) return [tables];
  const findings: Finding[] = [...checkPolicies(root, tables)];
  for (const { file, isTest } of listSourceFiles(join(root, KERNEL_SRC))) {
    if (isTest || file.endsWith(SCHEMA)) continue;
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      findings.push(parsed);
      continue;
    }
    findings.push(...checkOrgFilterFile(parsed, tables));
  }
  return findings;
}

/**
 * `org-filter-policy`: every org-scoped table has a row level security policy in some kernel
 * migration. Reported on the table's line in the schema.
 */
export function checkPolicies(root: string, tables: Set<string>): Finding[] {
  const dir = join(root, MIGRATIONS);
  const sqlText = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    // comments never count
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const schemaFile = join(root, SCHEMA);
  const schemaLines = readFileSync(schemaFile, "utf8").split("\n");
  const findings: Finding[] = [];
  for (const t of [...tables].sort()) {
    const name = `(?:capybara\\.)?"?${t}"?`;
    const hasPolicy = new RegExp(
      `\\bCREATE\\s+POLICY\\s+"?\\w+"?\\s+ON\\s+${name}(?![a-z0-9_])`,
      "i",
    ).test(sqlText);
    if (hasPolicy) continue;
    const idx = schemaLines.findIndex((l) => new RegExp(`^\\s*"?${t}"?\\s*:`).test(l));
    findings.push({
      file: schemaFile,
      line: idx >= 0 ? idx + 1 : 1,
      rule: "org-filter-policy",
      message: `org-scoped table "${t}" has no RLS policy in the kernel migrations: a table with org_id ships one in the migration that adds it (DROP POLICY IF EXISTS org_scope ON ${t}; CREATE POLICY org_scope ON ${t} USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id)); RLS spec §7)`,
    });
  }
  return findings;
}
