/**
 * The setup guide renderer (spec `2026-11-09-setup-guides-v2-design.md` §6, §7). It parses first
 * and substitutes into the tree, so a value never becomes Markdown syntax: section selection and
 * check markers (scanner), each known variable with a value as a private-use sentinel, a CommonMark +
 * GFM parse, substitution per node type (§6.2), sanitizing (§7.1), then cutting into blocks; prose
 * blocks are serialized back with `mdast-util-to-markdown`, which escapes text. Deterministic.
 */
import type { Link, Nodes, Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import {
  SETUP_GUIDE_LIMITS,
  SETUP_GUIDE_PLACE_INFO,
  type SetupGuideAudience,
  type SetupGuidePlace,
  type SetupGuideVariableType,
} from "./setup-guide.js";
import {
  checkMarkerIndex,
  fenceTitle,
  lineSelected,
  nodeText,
  normalizeGuideSource,
  parseGuideMarkdown,
  preparedGuideText,
  revertSentinels,
  SETUP_GUIDE_VARIABLE_RE,
  scanGuide,
} from "./setup-guide-parse.js";

/** A block of a rendered guide: sanitized Markdown, a code block, or a check row. */
export type SetupGuideBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string; title: string | null; text: string }
  | { kind: "check"; id: string; label: string };

/** A guide document rendered for one mode, audience and set of values. */
export interface RenderedSetupGuideDoc {
  title: string;
  /** The modes the document's sections use, in the place's order (empty: no mode switch). */
  modes: string[];
  /** The audiences the document has sections for, in the place's order. */
  audiences: SetupGuideAudience[];
  blocks: SetupGuideBlock[];
  /** The check rows, in document order. */
  checks: { id: string; label: string; source: "plugin" | "kernel" }[];
  /** Known variables without a value that the rendered text uses, in the place's order. */
  unresolved: string[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const AUTOLINKABLE_RE = /https?:\/\/|www\.|\S@\S+\.\S/i;
const QUOTING_LANGUAGES = new Set(["yaml", "yml", "json"]);

interface Entry {
  name: string;
  value: string;
  type: SetupGuideVariableType;
}

const clean = (s: string) => s.replace(CONTROL_RE, " ");

function httpUrl(url: string, allowHttp: boolean): boolean {
  if (!(allowHttp ? /^https?:\/\//i : /^https:\/\//i).test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders a guide document for a place, mode and audience (spec §6, §7): sections selected, known
 * variables with a value substituted and escaped for where they stand, unknown and unresolved ones
 * left as written, the tree sanitized (raw HTML as text, images as links or alt text, links only to
 * absolute https URLs or http(s) URLs built from a `url` variable), and cut into blocks. Pure and
 * deterministic.
 */
export function renderSetupGuide(
  source: string,
  input: {
    place: SetupGuidePlace;
    mode: string | null;
    audience: SetupGuideAudience;
    values: Readonly<Record<string, string | null | undefined>>;
  },
): RenderedSetupGuideDoc {
  const info = SETUP_GUIDE_PLACE_INFO[input.place];
  const scan = scanGuide(normalizeGuideSource(source));
  const include = (i: number) => lineSelected(scan, i, input.mode, input.audience);
  const entries: Entry[] = [];
  const missing = new Set<string>();
  const text = preparedGuideText(scan, include, (t) =>
    t.replace(SETUP_GUIDE_VARIABLE_RE, (whole, name: string) => {
      const type = Object.hasOwn(info.variables, name) ? info.variables[name] : undefined;
      if (type === undefined) return whole;
      const value = Object.hasOwn(input.values, name) ? input.values[name] : undefined;
      if (value === null || value === undefined) {
        missing.add(name);
        return whole;
      }
      entries.push({ name, value, type });
      return `${entries.length - 1}`;
    }),
  );
  const names = entries.map((e) => e.name);
  const revert = (s: string) => revertSentinels(s, names);
  const tree = parseGuideMarkdown(text);

  const definitions = new Map<string, string>();
  for (const n of tree.children) {
    if (n.type === "definition") definitions.set(n.identifier, n.url);
  }

  const substText = (value: string, inLink: boolean): PhrasingContent[] => {
    const out: PhrasingContent[] = [];
    const push = (s: string) => {
      if (s === "") return;
      const last = out.at(-1);
      if (last?.type === "text") last.value += s;
      else out.push({ type: "text", value: s });
    };
    let at = 0;
    for (const m of value.matchAll(/<(\d+)>|(\d+)/g)) {
      push(value.slice(at, m.index));
      at = m.index + m[0].length;
      const e = entries[Number(m[1] ?? m[2])];
      if (e === undefined) continue;
      if (m[1] !== undefined) {
        if (!inLink && e.type === "url" && httpUrl(e.value, true)) {
          out.push({
            type: "link",
            url: e.value,
            children: [{ type: "text", value: clean(e.value) }],
          });
        } else push(`<${clean(e.value)}>`);
      } else push(clean(e.value));
    }
    push(value.slice(at));
    return out;
  };

  const substCode = (value: string, lang: string): string =>
    value.replace(/(\d+)/g, (whole, n: string) => {
      const e = entries[Number(n)];
      if (e === undefined) return whole;
      return QUOTING_LANGUAGES.has(lang) ? JSON.stringify(e.value).slice(1, -1) : clean(e.value);
    });

  const substInline = (value: string): string =>
    value.replace(/\uE000(\d+)\uE001/g, (whole, n: string) => {
      const e = entries[Number(n)];
      return e === undefined ? whole : clean(e.value);
    });

  const finishLink = (url: string, children: PhrasingContent[]): PhrasingContent[] => {
    let href: string | null = null;
    const m = /^(?:|%EE%80%80)(\d+)(?:|%EE%80%81)/i.exec(url);
    const rest = m === null ? url : url.slice(m[0].length);
    const restHasSentinel = revert(rest) !== rest;
    if (m !== null) {
      const e = entries[Number(m[1])];
      if (
        e !== undefined &&
        e.type === "url" &&
        !restHasSentinel &&
        httpUrl(e.value + rest, true)
      ) {
        href = e.value + rest;
      }
    } else if (!restHasSentinel && httpUrl(url, false)) {
      href = url;
    }
    if (href === null) {
      // a refused link renders as its text; text the web's GFM parser would link again
      // (an autolink's URL, `www.`, an email address) renders as inline code instead
      const t = children.map((c) => nodeText(c)).join("");
      return AUTOLINKABLE_RE.test(t) ? [{ type: "inlineCode", value: clean(t) }] : children;
    }
    const link: Link = { type: "link", url: href, children };
    return [link];
  };

  const phrasing = (nodes: readonly Nodes[], depth: number, inLink: boolean): PhrasingContent[] =>
    nodes.flatMap((c) => tx(c, depth, false, inLink) as PhrasingContent[]);

  /** Transforms one node into its sanitized replacement(s). */
  const tx = (node: Nodes, depth: number, flow: boolean, inLink: boolean): RootContent[] => {
    const asText = (value: string): RootContent[] => {
      const t = substText(value, true);
      if (t.length === 0) return [];
      return flow ? [{ type: "paragraph", children: t } satisfies Paragraph] : t;
    };
    if (depth > SETUP_GUIDE_LIMITS.depth) return asText(nodeText(node));
    switch (node.type) {
      case "text":
        return substText(node.value, inLink);
      case "html":
        return asText(node.value);
      case "inlineCode":
        return [{ type: "inlineCode", value: substInline(node.value) }];
      case "code": {
        const lang = revert(node.lang ?? "");
        return [
          {
            type: "code",
            lang: lang === "" ? null : lang,
            meta: node.meta === null || node.meta === undefined ? null : revert(node.meta),
            value: substCode(node.value, lang.toLowerCase()),
          },
        ];
      }
      case "link": {
        const children = phrasing(node.children, depth + 1, true);
        return inLink ? children : finishLink(node.url, children);
      }
      case "linkReference": {
        const children = phrasing(node.children, depth + 1, true);
        if (inLink) return children;
        return finishLink(definitions.get(node.identifier) ?? "", children);
      }
      case "image":
      case "imageReference": {
        const alt = revert(node.alt ?? "");
        const url = node.type === "image" ? node.url : (definitions.get(node.identifier) ?? "");
        const altText: PhrasingContent[] = alt === "" ? [] : [{ type: "text", value: clean(alt) }];
        const out =
          !inLink && revert(url) === url && httpUrl(url, false)
            ? [
                {
                  type: "link",
                  url,
                  children: altText.length > 0 ? altText : [{ type: "text", value: url }],
                } satisfies Link,
              ]
            : altText;
        return flow && out.length > 0 ? [{ type: "paragraph", children: out }] : out;
      }
      case "definition":
      case "footnoteDefinition":
      case "footnoteReference":
        return [];
      case "heading":
        return [
          {
            type: "heading",
            depth: Math.min(Math.max(node.depth, 2), 4) as 2 | 3 | 4,
            children: phrasing(node.children, depth + 1, inLink),
          },
        ];
      case "paragraph":
        return [{ type: "paragraph", children: phrasing(node.children, depth + 1, inLink) }];
      case "emphasis":
      case "strong":
      case "delete":
        return [{ type: node.type, children: phrasing(node.children, depth + 1, inLink) }];
      case "tableCell":
        return [{ type: "tableCell", children: phrasing(node.children, depth + 1, inLink) }];
      case "blockquote":
        return [{ type: "blockquote", children: flowChildren(node.children, depth + 1) as never }];
      case "listItem":
        return [
          {
            type: "listItem",
            spread: node.spread ?? false,
            checked: node.checked ?? null,
            children: flowChildren(node.children, depth + 1) as never,
          },
        ];
      case "list":
        return [
          {
            type: "list",
            ordered: node.ordered ?? false,
            start: node.start ?? null,
            spread: node.spread ?? false,
            children: node.children.flatMap((c) => tx(c, depth + 1, false, inLink)) as never,
          },
        ];
      case "table":
        return [
          {
            type: "table",
            align: node.align ?? null,
            children: node.children.flatMap((c) => tx(c, depth + 1, false, inLink)) as never,
          },
        ];
      case "tableRow":
        return [
          {
            type: "tableRow",
            children: node.children.flatMap((c) => tx(c, depth + 1, false, inLink)) as never,
          },
        ];
      case "thematicBreak":
        return [{ type: "thematicBreak" }];
      case "break":
        return [{ type: "break" }];
      default:
        return asText(nodeText(node));
    }
  };

  const flowChildren = (nodes: readonly Nodes[], depth: number): RootContent[] =>
    nodes.flatMap((c) => tx(c, depth, true, false));

  // the title: the leading level-1 heading, lifted out
  let title = "";
  let body = tree.children;
  const first = body[0];
  if (first?.type === "heading" && first.depth === 1) {
    title = phrasing(first.children, 2, false)
      .map((n) => nodeText(n))
      .join("")
      .trim();
    body = body.slice(1);
  }

  const blocks: SetupGuideBlock[] = [];
  let group: RootContent[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const root: Root = { type: "root", children: group };
    const md = toMarkdown(root, { extensions: [gfmToMarkdown()], bullet: "-" }).replace(/\n+$/, "");
    if (md.trim() !== "") blocks.push({ kind: "markdown", text: md });
    group = [];
  };
  for (const node of body) {
    const c = checkMarkerIndex(node);
    if (c !== undefined) {
      const check = scan.checks[c];
      if (check !== undefined) {
        flush();
        blocks.push({ kind: "check", id: check.id, label: check.label });
      }
      continue;
    }
    if (node.type === "code") {
      flush();
      const lang = revert(node.lang ?? "");
      blocks.push({
        kind: "code",
        language: lang,
        title: fenceTitle(revert(node.meta ?? "")).title,
        text: substCode(node.value, lang.toLowerCase()),
      });
      continue;
    }
    group.push(...tx(node, 1, true, false));
  }
  flush();

  const usedModes = new Set<string>();
  const usedAudiences = new Set<string>();
  for (const s of scan.sections) (s.type === "mode" ? usedModes : usedAudiences).add(s.value);
  const checkSource = (id: string): "plugin" | "kernel" =>
    id.startsWith("capybara:") ? "kernel" : "plugin";
  return {
    title,
    modes: info.modes.filter((m) => usedModes.has(m)),
    audiences: info.audiences.filter((a) => usedAudiences.has(a)),
    blocks,
    checks: blocks.flatMap((b) =>
      b.kind === "check" ? [{ id: b.id, label: b.label, source: checkSource(b.id) }] : [],
    ),
    unresolved: Object.keys(info.variables).filter((n) => missing.has(n)),
  };
}
