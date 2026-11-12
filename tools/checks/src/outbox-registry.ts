import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
} from "./source.js";

/**
 * Outbox registry check (transactional outbox spec §10): every `OUTBOX_JOBS` entry in
 * `packages/kernel/src/infra/outbox/registry.ts` has
 *
 * - a non-empty `idempotent` sentence (why a duplicate delivery is harmless), and
 * - a `processedIn` that is an existing file containing `@Processor(` and mentioning the job
 *   name: a string literal equal to it, or an identifier of an exported constant whose value is
 *   it (`export const WAKE_JOB = "bg-wake"` anywhere in the kernel source).
 *
 * Rule: `outbox-registry`. The check parses the registry statically; a key or value it cannot
 * read (a computed key that is no known constant, a non-literal `processedIn`) is reported.
 */
export const REGISTRY_FILE = "packages/kernel/src/infra/outbox/registry.ts";
const RULE = "outbox-registry";

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

function visit(node: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const c of node) visit(c, fn);
  } else if (isNode(node)) {
    fn(node);
    for (const v of Object.values(node)) if (typeof v === "object") visit(v, fn);
  }
}

const str = (n: unknown): string | undefined =>
  isNode(n) && n.type === "Literal" && typeof n.value === "string" ? n.value : undefined;

/** `export const X = "value"` of every kernel source file: X → value. */
function exportedConstants(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file } of listSourceFiles(join(root, "packages/kernel/src"))) {
    const p = parseFile(file);
    if (isParseError(p)) continue;
    for (const s of p.program.body as Node[]) {
      if (s.type !== "ExportNamedDeclaration") continue;
      const d = s.declaration as Node | null;
      if (d?.type !== "VariableDeclaration") continue;
      for (const v of d.declarations as Node[]) {
        const id = v.id as Node;
        const value = str(v.init);
        if (id.type === "Identifier" && value !== undefined) out.set(id.name as string, value);
      }
    }
  }
  return out;
}

export function checkOutboxRegistry(root: string): Finding[] {
  const file = join(root, REGISTRY_FILE);
  if (!existsSync(file)) return [];
  const parsed = parseFile(file);
  if (isParseError(parsed)) return [parsed];
  const constants = exportedConstants(root);
  const out: Finding[] = [];
  const report = (at: Node, message: string) =>
    out.push({ file, line: (parsed as ParsedFile).lineOf(at.start), rule: RULE, message });

  let jobs: Node | undefined;
  visit(parsed.program, (n) => {
    if (n.type !== "VariableDeclarator" || (n.id as Node).name !== "OUTBOX_JOBS") return;
    let init = n.init as Node | undefined;
    while (init && init.type !== "ObjectExpression" && isNode(init.expression)) {
      init = init.expression as Node;
    }
    jobs = init;
  });
  if (jobs?.type !== "ObjectExpression") {
    return [{ file, line: 1, rule: RULE, message: "OUTBOX_JOBS must be an object literal" }];
  }

  for (const entry of jobs.properties as Node[]) {
    if (entry.type !== "Property") {
      report(entry, "an OUTBOX_JOBS entry must be a plain `name: { … }` property");
      continue;
    }
    const key = entry.key as Node;
    const name = entry.computed
      ? key.type === "Identifier"
        ? constants.get(key.name as string)
        : str(key)
      : key.type === "Identifier"
        ? (key.name as string)
        : str(key);
    if (name === undefined) {
      report(
        entry,
        "cannot read this OUTBOX_JOBS key: use a string or an exported string constant",
      );
      continue;
    }
    const spec = entry.value as Node;
    const field = (f: string): Node | undefined =>
      spec.type === "ObjectExpression"
        ? ((spec.properties as Node[]).find((p) => (p.key as Node | undefined)?.name === f)
            ?.value as Node | undefined)
        : undefined;

    const idempotent = str(field("idempotent"));
    if (idempotent === undefined || idempotent.trim() === "") {
      report(
        entry,
        `job "${name}": idempotent must be a non-empty sentence saying why a duplicate delivery is harmless`,
      );
    }
    const processedIn = str(field("processedIn"));
    if (processedIn === undefined) {
      report(entry, `job "${name}": processedIn must be a string literal path`);
      continue;
    }
    const path = join(root, processedIn);
    if (!existsSync(path)) {
      report(entry, `job "${name}": processedIn ${processedIn} does not exist`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (!text.includes("@Processor(")) {
      report(entry, `job "${name}": ${processedIn} has no @Processor( class`);
      continue;
    }
    const p = parseFile(path);
    let mentioned = false;
    if (!isParseError(p)) {
      visit(p.program, (n) => {
        if (str(n) === name) mentioned = true;
        if (n.type === "Identifier" && constants.get(n.name as string) === name) mentioned = true;
      });
    }
    if (!mentioned) {
      report(
        entry,
        `job "${name}": ${processedIn} does not mention the job name "${name}" (a string literal, or an exported constant whose value is it)`,
      );
    }
  }
  return out;
}
