/**
 * The machine-readable parts of docs/design/spec.md (§9.2): per component a state list and a size
 * table, each under an HTML comment marker on its own line. Pure TS (no DOM, no React), shared by
 * the unit test, the Playwright measuring spec and the side-by-side page.
 */

export type SizeRow = {
  part: string;
  state: string;
  property: string;
  value: string;
  line: number;
};
export type SizeTable = { component: string; rows: SizeRow[]; line: number };
export type StateList = { component: string; states: string[]; line: number };
export type Theme = "dark" | "light";

export class SpecFormatError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`spec.md:${line}: ${message}`);
    this.name = "SpecFormatError";
  }
}

const NAME = "[a-z][a-z0-9-]*";
const STATES_MARKER = new RegExp(`^<!--\\s*states:\\s*(${NAME})\\s*-->$`);
const TABLE_MARKER = new RegExp(`^<!--\\s*size-table:\\s*(${NAME})\\s*-->$`);
const HEADER = ["Part", "State", "Property", "Value"];

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim().replace(/^`|`$/g, ""));

type Marker = { kind: "states" | "table"; component: string; index: number };

function markers(lines: string[]): Marker[] {
  const out: Marker[] = [];
  lines.forEach((raw, index) => {
    const l = raw.trim();
    const s = l.match(STATES_MARKER);
    if (s?.[1]) out.push({ kind: "states", component: s[1], index });
    const t = l.match(TABLE_MARKER);
    if (t?.[1]) out.push({ kind: "table", component: t[1], index });
  });
  return out;
}

/** The first non-blank line after `index`, or -1. */
function nextLine(lines: string[], index: number): number {
  for (let i = index + 1; i < lines.length; i++) if (lines[i]?.trim()) return i;
  return -1;
}

function parseTable(lines: string[], m: Marker): SizeTable {
  const h = nextLine(lines, m.index);
  const header = h < 0 ? [] : cells(lines[h] ?? "");
  if (h < 0 || header.join("|") !== HEADER.join("|")) {
    throw new SpecFormatError(
      `size-table ${m.component}: expected the header "| ${HEADER.join(" | ")} |" right below the marker`,
      h < 0 ? m.index + 1 : h + 1,
    );
  }
  const sep = lines[h + 1]?.trim() ?? "";
  if (!/^\|(\s*:?-+:?\s*\|)+$/.test(sep)) {
    throw new SpecFormatError(`size-table ${m.component}: missing the |---| separator`, h + 2);
  }
  const rows: SizeRow[] = [];
  for (let i = h + 2; i < lines.length; i++) {
    const l = lines[i]?.trim() ?? "";
    if (!l.startsWith("|")) break;
    const c = cells(l);
    if (c.length !== 4 || c.some((x) => x === "")) {
      throw new SpecFormatError(`size-table ${m.component}: a row needs 4 non-empty cells`, i + 1);
    }
    const [part, state, property, value] = c as [string, string, string, string];
    rows.push({ part, state, property, value, line: i + 1 });
  }
  if (rows.length === 0) {
    throw new SpecFormatError(`size-table ${m.component}: no rows`, h + 1);
  }
  return { component: m.component, rows, line: m.index + 1 };
}

/** Every size table in the spec. Throws SpecFormatError on a malformed table. */
export function parseSizeTables(specMd: string): SizeTable[] {
  const lines = specMd.split("\n");
  return markers(lines)
    .filter((m) => m.kind === "table")
    .map((m) => parseTable(lines, m));
}

/** Every state list in the spec ("States: `a`, `b`" right below the marker). */
export function parseStateLists(specMd: string): StateList[] {
  const lines = specMd.split("\n");
  return markers(lines)
    .filter((m) => m.kind === "states")
    .map((m) => {
      const i = nextLine(lines, m.index);
      const l = i < 0 ? "" : (lines[i] ?? "").trim();
      if (!l.startsWith("States:")) {
        throw new SpecFormatError(
          `states ${m.component}: expected "States: \`a\`, \`b\`" right below the marker`,
          i < 0 ? m.index + 1 : i + 1,
        );
      }
      const states = [...l.matchAll(/`([^`]+)`/g)].map((x) => x[1] as string);
      return { component: m.component, states, line: m.index + 1 };
    });
}

/**
 * "<component>-<state>" for every state of `components` without a rendered block, plus
 * "<component>: no state list" for a component the spec has no list for.
 */
export function missingStates(
  lists: StateList[],
  blockIds: string[],
  components: string[],
): string[] {
  const rendered = new Set(blockIds);
  const out: string[] = [];
  for (const c of components) {
    const list = lists.find((l) => l.component === c);
    if (!list) {
      out.push(`${c}: no state list`);
      continue;
    }
    for (const s of list.states) if (!rendered.has(`${c}-${s}`)) out.push(`${c}-${s}`);
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A size-table value: a literal number (px), a size path without the `size.` prefix
 * (`row.default`, `pad.default.x`, `type.body`, `type.body.line`) or `color.<token>` for `theme`.
 */
export function resolveToken(tokens: unknown, value: string, theme: Theme): string | number {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  const fail = (): never => {
    throw new Error(`tokens.json has no "${value}"`);
  };
  if (!isRecord(tokens)) return fail();
  const parts = value.split(".");
  if (parts[0] === "color") {
    if (parts.length !== 2) return fail();
    const c = isRecord(tokens.color) ? tokens.color[parts[1] as string] : undefined;
    const v = isRecord(c) ? c[theme] : undefined;
    return typeof v === "string" ? v : fail();
  }
  const size = isRecord(tokens.size) ? tokens.size : {};
  const [group, step, sub] = parts as [string, string | undefined, string | undefined];
  const g = size[group];
  if (!isRecord(g) || step === undefined) return fail();
  const v = g[step];
  if (typeof v === "number") return sub === undefined ? v : fail();
  if (Array.isArray(v) && v.length === 2) {
    const [a, b] = v as [number, number];
    if (group === "type") return sub === undefined ? a : sub === "line" ? b : fail();
    if (group === "pad") return sub === "y" ? a : sub === "x" ? b : fail();
  }
  return fail();
}

const PART_TOKEN = new RegExp(`^(${NAME})((?:\\[[a-z][a-z0-9-]*=[a-z0-9-]+\\])*)$`);

/** A size-table Part as a CSS selector relative to the block (`root` is the block itself). */
export function partSelector(part: string): string {
  if (part === "root") return ":scope";
  return part
    .split(/\s+/)
    .map((tok) => {
      const m = tok.match(PART_TOKEN);
      if (!m) throw new SpecFormatError(`bad part "${part}"`, 0);
      const attrs = [...(m[2] ?? "").matchAll(/\[([a-z0-9-]+)=([a-z0-9-]+)\]/g)]
        .map(([, k, v]) => `[${k}="${v}"]`)
        .join("");
      return `[data-part="${m[1]}"]${attrs}`;
    })
    .join(" ");
}

/**
 * The spec rules for the formats: a size table without a state list, a row state not in the
 * list, a value tokens.json lacks, a bad part, a duplicate marker, a malformed table.
 */
export function checkSpecTables(
  specMd: string,
  tokens: unknown,
): { message: string; line: number }[] {
  const out: { message: string; line: number }[] = [];
  const lines = specMd.split("\n");
  const seen = new Map<string, number>();
  for (const m of markers(lines)) {
    const key = `${m.kind}:${m.component}`;
    if (seen.has(key)) {
      out.push({
        line: m.index + 1,
        message: `duplicate ${m.kind === "table" ? "size-table" : "states"} marker for ${m.component} (first at line ${seen.get(key)})`,
      });
    } else seen.set(key, m.index + 1);
  }
  let lists: StateList[];
  try {
    lists = parseStateLists(specMd);
  } catch (e) {
    if (e instanceof SpecFormatError) return [...out, { line: e.line, message: e.message }];
    throw e;
  }
  for (const m of markers(lines).filter((x) => x.kind === "table")) {
    let table: SizeTable;
    try {
      table = parseTable(lines, m);
    } catch (e) {
      if (e instanceof SpecFormatError) {
        out.push({ line: e.line, message: e.message });
        continue;
      }
      throw e;
    }
    if (seen.get(`table:${m.component}`) !== m.index + 1) continue; // the duplicate is reported
    const list = lists.find((l) => l.component === table.component);
    if (!list) {
      out.push({ line: table.line, message: `size-table ${table.component} has no state list` });
      continue;
    }
    for (const r of table.rows) {
      if (!list.states.includes(r.state)) {
        out.push({
          line: r.line,
          message: `state "${r.state}" (block ${table.component}-${r.state}) is not in the state list of ${table.component}`,
        });
      }
      try {
        partSelector(r.part);
      } catch {
        out.push({ line: r.line, message: `bad part "${r.part}"` });
      }
      for (const theme of ["dark", "light"] as const) {
        try {
          resolveToken(tokens, r.value, theme);
        } catch (e) {
          out.push({ line: r.line, message: (e as Error).message });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
