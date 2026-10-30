// Ported from octok-platform libs/common/src/utils/common.utils.ts#generateKey (owner-approved, 2026-10-28).

/** Reads a dotted path (`a.b.c`) from a value; undefined when any step is missing. */
function get(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const show = (v: unknown): string | undefined =>
  v !== undefined && v !== null ? String(v) : undefined;

/**
 * Expands the placeholders of a key template from the method arguments:
 * - `#{0}`: the argument at that index, as a string;
 * - `#{1.book.title}`: a property path of the argument at that index;
 * - `#{user.id}`: the same as `#{0.user.id}` (the index 0 may be omitted).
 *
 * With `opts.result` (cache eviction), `#{result}` and `#{result.id}` read the method's return value.
 *
 * A placeholder that cannot be resolved is left as written.
 */
export function generateKey(
  pattern: string,
  args: readonly unknown[],
  opts?: { result: unknown },
): string {
  if (opts) {
    pattern = pattern.replace(
      /#\{result(?:\.([^}]+))?\}/g,
      (match, path: string | undefined) =>
        (path === undefined ? show(opts.result) : show(get(opts.result, path))) ?? match,
    );
  }
  // `#{<index>.<path>}`
  let key = pattern.replace(/#\{(\d+)\.([^}]+)\}/g, (match, indexStr: string, path: string) => {
    const index = Number.parseInt(indexStr, 10);
    if (index >= args.length) return match;
    return show(get(args[index], path)) ?? match;
  });
  // `#{<path>}` reads from the first argument
  key = key.replace(/#\{([^}]+)\}/g, (match, content: string) => {
    if (/^\d+$/.test(content) || args.length === 0) return match;
    return show(get(args[0], content)) ?? match;
  });
  // `#{<index>}`
  key = key.replace(/#\{(\d+)\}/g, (match, indexStr: string) => {
    const index = Number.parseInt(indexStr, 10);
    return index < args.length ? String(args[index]) : match;
  });
  return key;
}
