import { ApiError } from "../errors.js";

// The endpoint fields an org may change on a connector made from a connector template (the
// template's `editableEndpoint`): shared by creating one more connector from the template
// (`templateConnectorInput`) and by editing a template connector (`ConnectorsService.update`).

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

/** Every leaf dot path of an object (arrays and non-object values are leaves). */
export function leafPaths(v: Record<string, unknown>, base = ""): string[] {
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const p = base ? `${base}.${k}` : k;
    if (isObj(x) && Object.keys(x).length > 0) out.push(...leafPaths(x, p));
    else out.push(p);
  }
  return out;
}

/** The value at a dot path of `v` (own keys only), undefined when absent. */
export function getPath(v: unknown, path: string): unknown {
  let node: unknown = v;
  for (const seg of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

/** Sets the value at a dot path of `obj`, creating the objects on the way. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node[seg])) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1] as string] = value;
}

/**
 * `base` (a copy) with the fields of `given` merged in, each only at a path listed in `editable`
 * or under one; any other path -> 400 `validation_failed` at `<at>.endpoint.<path>` ("set by the
 * template"; `at` empty: `endpoint.<path>`), an unsafe key or a non-object `given` too. Returns the merged endpoint and the
 * editable paths `given` set (its leaves, for an audit that names paths, never values).
 */
export function mergeEditableEndpoint(
  base: unknown,
  editable: readonly string[],
  given: unknown,
  at: string,
): { endpoint: Record<string, unknown>; changed: string[] } {
  const endpoint = structuredClone(isObj(base) ? base : {});
  const root = at === "" ? "endpoint" : `${at}.endpoint`;
  if (!isObj(given)) throw fail(root, "Expected an object");
  const leaves = leafPaths(given);
  for (const p of leaves) {
    if (p.split(".").some((s) => UNSAFE_KEYS.has(s))) {
      throw fail(`${root}.${p}`, "Invalid key");
    }
    if (!editable.some((e) => p === e || p.startsWith(`${e}.`))) {
      throw fail(
        `${root}.${p}`,
        "This endpoint field is set by the template and cannot be changed",
      );
    }
  }
  for (const e of editable) {
    const v = getPath(given, e);
    if (v !== undefined) setPath(endpoint, e, v);
  }
  return { endpoint, changed: leaves };
}
