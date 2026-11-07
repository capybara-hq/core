import { Injectable } from "@nestjs/common";
import { tokenize } from "../tools/builtins/tool-search.js";
import {
  OPERATION_ID,
  operationDomain,
  PLATFORM_DOMAINS,
  type PlatformOperation,
} from "./operation.js";

/** A word of an operation id weighs more than a word of its description (like ToolSearch). */
const ID_WEIGHT = 2;
/** The shortest query term that also matches as a word's prefix (`skill` → `skills`). */
const MIN_PREFIX = 3;

const DOMAIN_IDS: ReadonlySet<string> = new Set(PLATFORM_DOMAINS.map((d) => d.id));

const byId = (a: PlatformOperation, b: PlatformOperation): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** A query term matches a word when equal, or as its prefix when long enough. */
const matches = (words: ReadonlySet<string>, term: string): boolean => {
  if (words.has(term)) return true;
  if (term.length < MIN_PREFIX) return false;
  for (const w of words) if (w.startsWith(term)) return true;
  return false;
};

/**
 * The `Platform` tool's operations (spec §7). Domain providers add theirs with {@link register}
 * from `onModuleInit` (ruling P2: this module imports no domain module); a bad batch throws and
 * registers nothing, so a mistake fails the kernel's start.
 */
@Injectable()
export class PlatformOperations {
  private readonly ops = new Map<string, PlatformOperation>();

  /**
   * Adds `ops`. Throws on an id not shaped `<domain>.<verb>`, a domain outside
   * {@link PLATFORM_DOMAINS}, a duplicate id (in the batch or already registered), or a write
   * (`confirm` other than `read`) without `summary`.
   */
  register(ops: readonly PlatformOperation[]): void {
    const seen = new Set<string>();
    for (const op of ops) {
      if (!OPERATION_ID.test(op.id)) {
        throw new Error(`Platform operation id "${op.id}" is not shaped <domain>.<verb>`);
      }
      if (!DOMAIN_IDS.has(operationDomain(op.id))) {
        throw new Error(`Platform operation "${op.id}" names an unknown domain`);
      }
      if (seen.has(op.id) || this.ops.has(op.id)) {
        throw new Error(`duplicate Platform operation "${op.id}"`);
      }
      if (op.confirm !== "read" && op.summary === undefined) {
        throw new Error(`Platform operation "${op.id}" is a write without a summary`);
      }
      seen.add(op.id);
    }
    for (const op of ops) this.ops.set(op.id, op);
  }

  domains(): readonly { id: string; description: string }[] {
    return PLATFORM_DOMAINS;
  }

  /** The domain's operations, sorted by id. */
  inDomain(domain: string): PlatformOperation[] {
    return this.all().filter((op) => operationDomain(op.id) === domain);
  }

  get(id: string): PlatformOperation | null {
    return this.ops.get(id) ?? null;
  }

  /** Every operation, sorted by id. */
  all(): PlatformOperation[] {
    return [...this.ops.values()].sort(byId);
  }

  /**
   * Keyword search (deterministic, like ToolSearch's): per distinct query term,
   * `idf × (ID_WEIGHT if in the id + 1 if in the description)`; a term also matches a word it is a
   * prefix of. Zero scores are dropped; ties go by id.
   */
  search(query: string, limit: number): PlatformOperation[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const docs = this.all().map((op) => ({
      op,
      id: new Set(tokenize(op.id)),
      desc: new Set(tokenize(op.description)),
    }));
    const n = docs.length;
    const idf = new Map<string, number>();
    for (const term of terms) {
      const df = docs.filter((d) => matches(d.id, term) || matches(d.desc, term)).length;
      idf.set(term, df === 0 ? 0 : Math.log(1 + n / df));
    }
    return docs
      .map((d) => {
        let score = 0;
        for (const term of terms) {
          const w = (matches(d.id, term) ? ID_WEIGHT : 0) + (matches(d.desc, term) ? 1 : 0);
          score += w * (idf.get(term) ?? 0);
        }
        return { op: d.op, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : byId(a.op, b.op)))
      .slice(0, limit)
      .map((x) => x.op);
  }
}
