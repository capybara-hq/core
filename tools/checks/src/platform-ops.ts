import { existsSync } from "node:fs";
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
 * `check:platform-ops` (Platform tool spec §9): the `Platform` tool stays complete. Every kernel
 * HTTP route (`@Controller` prefix plus `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete`, also the
 * argument-less form) is mirrored by an operation (`defineOperation` in `platform/ops/*.ops.ts`,
 * its `mirrors`) or excluded in `platform/exclusions.ts` with a reason. The rules:
 *
 * - platform-op-missing: a route neither mirrored nor excluded;
 * - platform-op-exclusion-reason: an empty reason, or `later` without an `issue` URL;
 * - platform-op-authz: an operation's `authz` differs from the route's (`@OrgAction` / `@SuperAdmin`
 *   on the method or the class); with `authzNote: "service-enforced"` its role must be at least
 *   the route's;
 * - platform-op-orphan: a mirror or exclusion naming no route (a removed route takes its
 *   operations and exclusion entries with it, spec §14.1 item 4);
 * - platform-op-describe: an operation without `description`, `example`, or (not `read`) `summary`;
 * - platform-op-literal: `mirrors` / `authz` that are not literals (the check cannot read them);
 * - platform-op-errors: an `errors` entry without a `next` step (spec §14.5 item 7): `errors` is an
 *   array literal of `{ code, next }` object literals, `code` a string, `next` a non-empty string
 *   or an object literal keyed `superAdmin` / `orgAdmin` / `member` (non-empty strings) with an
 *   `orgAdmin` or `member` step, so every role of the org gets one.
 */
export const PLATFORM_OP_RULES = [
  "platform-op-missing",
  "platform-op-exclusion-reason",
  "platform-op-authz",
  "platform-op-orphan",
  "platform-op-describe",
  "platform-op-literal",
  "platform-op-errors",
] as const;

const KERNEL_SRC = "packages/kernel/src";
const HTTP = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
]);

type Authz = { kind: "org"; action: string } | { kind: "super" } | { kind: "public" };

interface Route {
  key: string;
  file: string;
  line: number;
  authz: Authz | undefined;
}

interface Op {
  id: string;
  file: string;
  line: number;
  mirrors: string[] | undefined;
  authz: Authz | undefined;
  serviceEnforced: boolean;
}

const nameOf = (n: unknown): string | undefined => {
  const x = n as Node | undefined;
  return x && (x.type === "Identifier" || x.type === "PrivateIdentifier")
    ? (x.name as string)
    : undefined;
};

/** The name a decorator is called by: `@X`, `@X(...)`, `@ns.X(...)`. */
function decoratorName(d: Node): string | undefined {
  let e = d.expression as Node;
  if (e.type === "CallExpression") e = e.callee as Node;
  if (e.type === "MemberExpression") return nameOf(e.property);
  return nameOf(e);
}

const decoratorsOf = (n: Node): Node[] => (n.decorators as Node[] | undefined) ?? [];
const callArgs = (d: Node): Node[] =>
  d.expression && (d.expression as Node).type === "CallExpression"
    ? (((d.expression as Node).arguments as Node[]) ?? [])
    : [];

/** `"/" + the non-empty segments`, slashes trimmed, so `a/`, `/a` and `a` join the same way. */
function joinPath(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split("/")).filter((s) => s !== "");
  return `/${segs.join("/")}`;
}

function authzOf(decorators: Node[]): Authz | undefined {
  for (const d of decorators) {
    const name = decoratorName(d);
    if (name === "OrgAction") {
      const a = stringValue(callArgs(d)[0]);
      if (a !== undefined) return { kind: "org", action: a };
    } else if (name === "SuperAdmin") return { kind: "super" };
    else if (name === "Public") return { kind: "public" };
  }
  return undefined;
}

const describeAuthz = (a: Authz | undefined): string =>
  a === undefined
    ? "none"
    : a.kind === "org"
      ? `orgAction ${a.action}`
      : a.kind === "super"
        ? "superAdmin"
        : "public";

/** The `@Controller` prefix; `null` when it is not a string literal, `undefined` for a non-controller. */
function controllerPrefix(cls: Node): string | null | undefined {
  const d = decoratorsOf(cls).find((x) => decoratorName(x) === "Controller");
  if (!d) return undefined;
  const arg = callArgs(d)[0];
  if (!arg) return "";
  if (arg.type === "ObjectExpression") {
    const p = (arg.properties as Node[]).find(
      (q) => q.type === "Property" && nameOf(q.key) === "path",
    );
    if (!p) return "";
    return stringValue(p.value) ?? null;
  }
  return stringValue(arg) ?? null;
}

function readRoutes(p: ParsedFile, findings: Finding[]): Route[] {
  const out: Route[] = [];
  walk(p.program, (cls) => {
    if (cls.type !== "ClassDeclaration" && cls.type !== "ClassExpression") return;
    const prefix = controllerPrefix(cls);
    if (prefix === undefined) return;
    const classAuthz = authzOf(decoratorsOf(cls));
    for (const m of ((cls.body as Node).body as Node[]) ?? []) {
      if (m.type !== "MethodDefinition") continue;
      const ds = decoratorsOf(m);
      for (const route of ds.filter((d) => HTTP.has(decoratorName(d) ?? ""))) {
        const line = p.lineOf(route.start);
        const arg = callArgs(route)[0];
        const path = arg ? stringValue(arg) : "";
        if (prefix === null || path === undefined) {
          findings.push({
            file: p.file,
            line,
            rule: "platform-op-literal",
            message: `${prefix === null ? "controller prefix" : "route path"} must be a string literal, so the route cannot be matched to an operation`,
          });
          continue;
        }
        const method = HTTP.get(decoratorName(route) as string) as string;
        out.push({
          key: `${method} ${joinPath(prefix, path)}`,
          file: p.file,
          line,
          authz: authzOf(ds) ?? classAuthz,
        });
      }
    }
  });
  return out;
}

const prop = (obj: Node, name: string): Node | undefined =>
  (obj.properties as Node[]).find(
    (q) => (q.type === "Property" || q.type === "MethodDefinition") && nameOf(q.key) === name,
  );

function readAuthz(n: Node | undefined): Authz | undefined {
  if (n?.type !== "ObjectExpression") return undefined;
  const oa = prop(n, "orgAction");
  if (oa) {
    const a = stringValue(oa.value);
    return a === undefined ? undefined : { kind: "org", action: a };
  }
  const sa = prop(n, "superAdmin");
  const v = sa?.value as Node | undefined;
  return v?.type === "Literal" && v.value === true ? { kind: "super" } : undefined;
}

function readMirrors(n: Node | undefined): string[] | undefined {
  if (n?.type !== "ArrayExpression") return undefined;
  const out: string[] = [];
  for (const e of n.elements as Node[]) {
    const s = stringValue(e);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

function readOps(p: ParsedFile, out: Finding[]): Op[] {
  const ops: Op[] = [];
  walk(p.program, (n) => {
    if (n.type !== "CallExpression" || nameOf(n.callee) !== "defineOperation") return;
    const obj = (n.arguments as Node[])[0];
    if (obj?.type !== "ObjectExpression") {
      out.push({
        file: p.file,
        line: p.lineOf(n.start),
        rule: "platform-op-literal",
        message: "defineOperation takes an object literal, so the check cannot read the operation",
      });
      return;
    }
    const line = p.lineOf((prop(obj, "id") ?? obj).start);
    const add = (rule: string, message: string) => out.push({ file: p.file, line, rule, message });
    const id = stringValue(prop(obj, "id")?.value) ?? "<unknown>";
    const mirrors = readMirrors(prop(obj, "mirrors")?.value as Node | undefined);
    const authz = readAuthz(prop(obj, "authz")?.value as Node | undefined);
    if (mirrors === undefined) {
      add("platform-op-literal", `${id}: \`mirrors\` must be an array of string literals`);
    }
    if (authz === undefined) {
      add(
        "platform-op-literal",
        `${id}: \`authz\` must be a literal { orgAction: "<action>" } or { superAdmin: true }`,
      );
    }
    const description = stringValue(prop(obj, "description")?.value);
    if (description === undefined || description.trim() === "") {
      add("platform-op-describe", `${id}: missing \`description\``);
    }
    if (!prop(obj, "example")) add("platform-op-describe", `${id}: missing \`example\``);
    const confirm = stringValue(prop(obj, "confirm")?.value);
    if (confirm !== "read" && !prop(obj, "summary")) {
      add(
        "platform-op-describe",
        `${id}: a write (confirm \`${confirm ?? "?"}\`) needs a \`summary\``,
      );
    }
    const errors = prop(obj, "errors");
    if (errors) {
      for (const problem of errorProblems(errors.value as Node))
        add("platform-op-errors", `${id}: ${problem}`);
    }
    ops.push({
      id,
      file: p.file,
      line,
      mirrors,
      authz,
      serviceEnforced: stringValue(prop(obj, "authzNote")?.value) === "service-enforced",
    });
  });
  return ops;
}

const ROLE_KEYS = new Set(["superAdmin", "orgAdmin", "member"]);
const nonEmpty = (n: Node | undefined): boolean => (stringValue(n)?.trim() ?? "") !== "";

/** What is wrong with an operation's `errors` literal (rule `platform-op-errors`). */
function errorProblems(n: Node): string[] {
  if (n.type !== "ArrayExpression") {
    return ["`errors` must be an array literal of { code, next } objects"];
  }
  const out: string[] = [];
  for (const e of n.elements as Node[]) {
    if (e?.type !== "ObjectExpression") {
      out.push("each `errors` entry must be an object literal { code, next }");
      continue;
    }
    const code = stringValue(prop(e, "code")?.value);
    const label = code === undefined ? "an `errors` entry" : `error \`${code}\``;
    if (code === undefined) out.push("an `errors` entry needs a string literal `code`");
    const next = prop(e, "next")?.value as Node | undefined;
    if (next === undefined) {
      out.push(`${label} has no \`next\`: say what to do next`);
    } else if (next.type === "ObjectExpression") {
      const keys: string[] = [];
      for (const q of next.properties as Node[]) {
        const k = q.type === "Property" ? (nameOf(q.key) ?? stringValue(q.key)) : undefined;
        if (k === undefined || !ROLE_KEYS.has(k) || !nonEmpty(q.value as Node)) {
          out.push(
            `${label}: a role-keyed \`next\` takes only superAdmin / orgAdmin / member, each a non-empty string literal`,
          );
          continue;
        }
        keys.push(k);
      }
      if (!keys.includes("orgAdmin") && !keys.includes("member")) {
        out.push(`${label}: a role-keyed \`next\` needs an orgAdmin or member step`);
      }
    } else if (!nonEmpty(next)) {
      out.push(`${label}: \`next\` must be a non-empty string literal or a role-keyed object`);
    }
  }
  return out;
}

interface Exclusion {
  route: string;
  category: string | undefined;
  reason: string | undefined;
  issue: string | undefined;
  line: number;
}

function readExclusions(p: ParsedFile, findings: Finding[]): Exclusion[] {
  const out: Exclusion[] = [];
  walk(p.program, (n) => {
    if (n.type !== "VariableDeclarator" || nameOf(n.id) !== "PLATFORM_EXCLUSIONS") return;
    let init = n.init as Node | undefined;
    while (init && (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression")) {
      init = init.expression as Node;
    }
    if (init?.type !== "ArrayExpression") return;
    for (const e of init.elements as Node[]) {
      if (e?.type !== "ObjectExpression") continue;
      const route = stringValue(prop(e, "route")?.value);
      if (route === undefined) {
        findings.push({
          file: p.file,
          line: p.lineOf(e.start),
          rule: "platform-op-literal",
          message: "an exclusion's `route` must be a string literal",
        });
        continue;
      }
      out.push({
        route,
        category: stringValue(prop(e, "category")?.value),
        reason: stringValue(prop(e, "reason")?.value),
        issue: stringValue(prop(e, "issue")?.value),
        line: p.lineOf(e.start),
      });
    }
  });
  return out;
}

const ROLE_ORDER = ["guest", "member", "admin", "owner"];

/** `ACTION_MIN_ROLE` read from orgs/roles.ts (statically, so the check runs under tsx alone). */
function readRoles(file: string): Map<string, string> {
  const roles = new Map<string, string>();
  if (!existsSync(file)) return roles;
  const p = parseFile(file);
  if (isParseError(p)) return roles;
  walk(p.program, (n) => {
    if (n.type !== "VariableDeclarator" || nameOf(n.id) !== "ACTION_MIN_ROLE") return;
    const init = n.init as Node | undefined;
    if (init?.type !== "ObjectExpression") return;
    for (const q of init.properties as Node[]) {
      if (q.type !== "Property") continue;
      const k = nameOf(q.key) ?? stringValue(q.key);
      const v = stringValue(q.value);
      if (k !== undefined && v !== undefined) roles.set(k, v);
    }
  });
  return roles;
}

/** The `<METHOD> <path>` keys of every kernel HTTP route under `root` (the parity test's list). */
export function kernelRoutes(root: string): Set<string> {
  const keys = new Set<string>();
  for (const { file, isTest } of listSourceFiles(join(root, KERNEL_SRC))) {
    if (isTest || !file.endsWith(".ts")) continue;
    const p = parseFile(file);
    if (isParseError(p)) continue;
    for (const r of readRoutes(p, [])) keys.add(r.key);
  }
  return keys;
}

export function checkPlatformOps(root: string): Finding[] {
  const out: Finding[] = [];
  const src = join(root, KERNEL_SRC);
  const routes = new Map<string, Route>();
  const ops: Op[] = [];
  let exclusions: Exclusion[] = [];
  const exclusionsFile = join(src, "platform/exclusions.ts");

  for (const { file, isTest } of listSourceFiles(src)) {
    if (isTest) continue;
    const isOps = /\/platform\/ops\/[^/]+\.ops\.ts$/.test(file);
    const isExclusions = file === exclusionsFile;
    const isController = file.endsWith(".ts");
    if (!isOps && !isExclusions && !isController) continue;
    const p = parseFile(file);
    if (isParseError(p)) {
      out.push(p);
      continue;
    }
    if (isOps) ops.push(...readOps(p, out));
    if (isExclusions) exclusions = readExclusions(p, out);
    for (const r of readRoutes(p, out)) routes.set(r.key, r);
  }

  const roles = readRoles(join(src, "orgs/roles.ts"));
  const rank = (a: Authz | undefined): number | undefined => {
    if (a?.kind !== "org") return undefined;
    const r = roles.get(a.action);
    return r === undefined ? undefined : ROLE_ORDER.indexOf(r);
  };

  const mirrored = new Set<string>();
  for (const op of ops) {
    for (const m of op.mirrors ?? []) {
      mirrored.add(m);
      const route = routes.get(m);
      if (!route) {
        out.push({
          file: op.file,
          line: op.line,
          rule: "platform-op-orphan",
          message: `${op.id}: operation mirrors a route that does not exist: \`${m}\``,
        });
        continue;
      }
      if (!op.authz) continue;
      const same = describeAuthz(op.authz) === describeAuthz(route.authz);
      if (same) continue;
      let ok = false;
      if (op.serviceEnforced) {
        const a = rank(op.authz);
        const b = rank(route.authz);
        ok = a !== undefined && b !== undefined && a >= b;
      }
      if (!ok) {
        out.push({
          file: op.file,
          line: op.line,
          rule: "platform-op-authz",
          message: `${op.id}: authz is ${describeAuthz(op.authz)} but \`${m}\` requires ${describeAuthz(route.authz)}${
            op.serviceEnforced
              ? " (service-enforced needs a role at least the route's)"
              : ' (use `authzNote: "service-enforced"` only when the service enforces a higher role)'
          }`,
        });
      }
    }
  }

  const excluded = new Set<string>();
  for (const e of exclusions) {
    excluded.add(e.route);
    const at = { file: exclusionsFile, line: e.line };
    if (!routes.has(e.route)) {
      out.push({
        ...at,
        rule: "platform-op-orphan",
        message: `exclusion names a route that does not exist: \`${e.route}\``,
      });
    }
    if (e.reason === undefined || e.reason.trim() === "") {
      out.push({
        ...at,
        rule: "platform-op-exclusion-reason",
        message: `\`${e.route}\` has no reason`,
      });
    }
    if (e.category === "later" && !/^https?:\/\/\S+$/.test(e.issue ?? "")) {
      out.push({
        ...at,
        rule: "platform-op-exclusion-reason",
        message: `\`${e.route}\` is \`later\` and needs an \`issue\` URL`,
      });
    }
  }

  for (const r of routes.values()) {
    if (mirrored.has(r.key) || excluded.has(r.key)) continue;
    out.push({
      file: r.file,
      line: r.line,
      rule: "platform-op-missing",
      message: `${r.key} is neither mirrored by a Platform operation nor excluded in platform/exclusions.ts`,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
