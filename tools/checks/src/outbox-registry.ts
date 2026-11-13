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
 * - a `processedIn` that is an existing file containing `@Processor(` (or `configuredProcessor(`,
 *   which applies `@Processor` with the startup config's worker options) and mentioning the job
 *   name: a string literal equal to it, or an identifier of an exported constant whose value is
 *   it (`export const WAKE_JOB = "bg-wake"` anywhere in the kernel source);
 *
 * and every `outbox.add({ queue, name })` / `outbox.addMany(jobs.map(() => ({ queue, name })))`
 * in the kernel source whose `queue` and `name` are both statically resolvable (a string literal,
 * or an exported string constant) adds a registered name to one of its entry's queues. A queue
 * computed at run time (`runQueueNameFor(kind)`) is not checked: the type `KernelQueueName` keeps
 * it a kernel queue, and the dispatcher's add fails loudly on a queue it has no producer for.
 *
 * Rule: `outbox-registry`. The check parses the registry statically; a key or value it cannot
 * read (a computed key that is no known constant, a non-literal `processedIn`) is reported.
 */
export const REGISTRY_FILE = "packages/kernel/src/infra/outbox/registry.ts";
const RULE = "outbox-registry";
/** A processor: a `@Processor(` class, or one registered through `configuredProcessor(`. */
const PROCESSOR = /@Processor\(|\bconfiguredProcessor\(/;

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

/** An `outbox.add` / `outbox.addMany` call's job fields, read where the call is. */
interface OwedAdd {
  file: string;
  line: number;
  queue: Node | undefined;
  name: Node | undefined;
}

/** The job object of an `outbox.add(` call, or the mapped one of `outbox.addMany(xs.map(…))`. */
function jobObjectOf(method: string, arg: Node | undefined): Node | undefined {
  let n = arg;
  if (method === "addMany") {
    if (n?.type !== "CallExpression") return undefined;
    const fn = (n.arguments as Node[])[0];
    if (fn?.type !== "ArrowFunctionExpression") return undefined;
    n = fn.body as Node;
  }
  while (n?.type === "ParenthesizedExpression") n = n.expression as Node;
  return n?.type === "ObjectExpression" ? n : undefined;
}

/**
 * One pass over the kernel source: `export const X = "value"` of every file (X → value), and the
 * `outbox.add` / `outbox.addMany` calls outside tests.
 */
function scanKernel(root: string): { constants: Map<string, string>; adds: OwedAdd[] } {
  const constants = new Map<string, string>();
  const adds: OwedAdd[] = [];
  for (const { file, isTest } of listSourceFiles(join(root, "packages/kernel/src"))) {
    const p = parseFile(file);
    if (isParseError(p)) continue;
    for (const s of p.program.body as Node[]) {
      if (s.type !== "ExportNamedDeclaration") continue;
      const d = s.declaration as Node | null;
      if (d?.type !== "VariableDeclaration") continue;
      for (const v of d.declarations as Node[]) {
        const id = v.id as Node;
        const value = str(v.init);
        if (id.type === "Identifier" && value !== undefined)
          constants.set(id.name as string, value);
      }
    }
    if (isTest) continue;
    visit(p.program, (n) => {
      if (n.type !== "CallExpression") return;
      const callee = n.callee as Node;
      if (callee.type !== "MemberExpression" || callee.computed) return;
      const method = (callee.property as Node).name as string;
      if (method !== "add" && method !== "addMany") return;
      const holder = callee.object as Node;
      const holderName =
        holder.type === "MemberExpression"
          ? ((holder.property as Node).name as string | undefined)
          : (holder.name as string | undefined);
      if (holderName !== "outbox") return;
      const job = jobObjectOf(method, (n.arguments as Node[])[0]);
      if (job === undefined) return;
      const field = (f: string) =>
        (job.properties as Node[]).find(
          (q) => q.type === "Property" && (q.key as Node).name === f && !q.computed,
        )?.value as Node | undefined;
      adds.push({ file, line: p.lineOf(n.start), queue: field("queue"), name: field("name") });
    });
  }
  return { constants, adds };
}

export function checkOutboxRegistry(root: string): Finding[] {
  const file = join(root, REGISTRY_FILE);
  if (!existsSync(file)) return [];
  const parsed = parseFile(file);
  if (isParseError(parsed)) return [parsed];
  const { constants, adds } = scanKernel(root);
  const out: Finding[] = [];
  /** Each registered name's queues, when its `queue` field could be read. */
  const queuesOf = new Map<string, string[]>();
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

    const queueField = field("queue");
    const queues =
      queueField?.type === "ArrayExpression"
        ? (queueField.elements as Node[]).map((e) => str(e))
        : [str(queueField)];
    if (queues.every((q) => q !== undefined)) queuesOf.set(name, queues as string[]);

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
    if (!PROCESSOR.test(text)) {
      report(
        entry,
        `job "${name}": ${processedIn} has no @Processor( class (nor a configuredProcessor( provider)`,
      );
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

  const resolve = (n: Node | undefined): string | undefined =>
    n?.type === "Identifier" ? constants.get(n.name as string) : str(n);
  for (const add of adds) {
    const name = resolve(add.name);
    const queue = resolve(add.queue);
    const allowed = name === undefined ? undefined : queuesOf.get(name);
    if (queue === undefined || allowed === undefined || allowed.includes(queue)) continue;
    out.push({
      file: add.file,
      line: add.line,
      rule: RULE,
      message: `job "${name}" is owed on queue "${queue}", but its OUTBOX_JOBS entry lists ${allowed.map((q) => `"${q}"`).join(", ")}`,
    });
  }
  return out;
}
