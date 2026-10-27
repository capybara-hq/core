import type {
  Definition,
  ImageReference,
  LinkReference,
  List,
  ListItem,
  Nodes,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { Fragment, type JSX, type ReactNode, useMemo } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { CodeBlock } from "./chat";

/**
 * Rendered Markdown (design spec §6.16.4): mdast to React elements, never HTML. Raw HTML renders
 * as text, links only for absolute http(s) URLs (new tab, no opener or referrer), images are never
 * loaded (an http(s) image becomes a link with its alt text), GFM tables stop at
 * {@link MARKDOWN_TABLE_MAX_ROWS} rows.
 */
export type MarkdownProps = {
  text: string;
  /** Inline code or text equal to one of these paths renders as a file chip calling onOpenPath. */
  paths?: ReadonlySet<string>;
  onOpenPath?(path: string): void;
  /** Appended inside the last block, after its text (the streaming cursor). */
  tail?: ReactNode;
};

/** Body rows a Markdown table shows before "N more rows". */
export const MARKDOWN_TABLE_MAX_ROWS = 200;

/** Nesting below this depth renders as plain text (hostile input stays cheap to render). */
const MAX_DEPTH = 48;

/** Only absolute http(s) URLs become links. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parse(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** The plain text of a node (alt text, over-deep content). */
function plain(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if ("children" in node) return (node.children as Nodes[]).map(plain).join("");
  return "";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Ctx = {
  defs: Map<string, Definition>;
  paths: ReadonlySet<string>;
  pathRe: RegExp | null;
  onOpenPath: ((path: string) => void) | undefined;
  moreRows: (n: number) => string;
  taskLabel: (done: boolean) => string;
};

function collectDefinitions(node: Nodes, into: Map<string, Definition>): void {
  if (node.type === "definition") {
    if (!into.has(node.identifier)) into.set(node.identifier, node);
    return;
  }
  if ("children" in node) for (const c of node.children as Nodes[]) collectDefinitions(c, into);
}

function chip(path: string, ctx: Ctx, key: string | number): ReactNode {
  const open = ctx.onOpenPath;
  return (
    <button
      key={key}
      type="button"
      className="cb-md-chip"
      data-part="file-chip"
      onClick={() => open?.(path)}
    >
      {path}
    </button>
  );
}

/** Text with file-output paths turned into chips. */
function textWithChips(value: string, ctx: Ctx): ReactNode {
  if (ctx.pathRe === null) return value;
  const out: ReactNode[] = [];
  let last = 0;
  ctx.pathRe.lastIndex = 0;
  for (let m = ctx.pathRe.exec(value); m !== null; m = ctx.pathRe.exec(value)) {
    if (m.index > last) out.push(value.slice(last, m.index));
    out.push(chip(m[0], ctx, m.index));
    last = m.index + m[0].length;
  }
  if (out.length === 0) return value;
  if (last < value.length) out.push(value.slice(last));
  return out;
}

function link(href: string, children: ReactNode, key: string | number): ReactNode {
  return (
    <a
      key={key}
      className="cb-md-link"
      data-part="md-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

function resolve(node: LinkReference | ImageReference, ctx: Ctx): string | null {
  return ctx.defs.get(node.identifier)?.url ?? null;
}

function phrasing(nodes: PhrasingContent[], ctx: Ctx, depth: number): ReactNode[] {
  return nodes.map((n, i) => inline(n, ctx, depth, i));
}

function inline(node: PhrasingContent, ctx: Ctx, depth: number, key: number): ReactNode {
  if (depth > MAX_DEPTH) return <Fragment key={key}>{plain(node)}</Fragment>;
  const kids = (n: Parents & { children: PhrasingContent[] }) =>
    phrasing(n.children, ctx, depth + 1);
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{textWithChips(node.value, ctx)}</Fragment>;
    case "html":
      return <Fragment key={key}>{node.value}</Fragment>;
    case "emphasis":
      return <em key={key}>{kids(node)}</em>;
    case "strong":
      return <strong key={key}>{kids(node)}</strong>;
    case "delete":
      return <del key={key}>{kids(node)}</del>;
    case "break":
      return <br key={key} />;
    case "inlineCode":
      return ctx.onOpenPath !== undefined && ctx.paths.has(node.value) ? (
        chip(node.value, ctx, key)
      ) : (
        <code key={key} className="cb-md-code" data-part="inline-code">
          {node.value}
        </code>
      );
    case "link":
      return isHttpUrl(node.url) ? (
        link(node.url, kids(node), key)
      ) : (
        <Fragment key={key}>{kids(node)}</Fragment>
      );
    case "linkReference": {
      const url = resolve(node, ctx);
      return url !== null && isHttpUrl(url) ? (
        link(url, kids(node), key)
      ) : (
        <Fragment key={key}>{kids(node)}</Fragment>
      );
    }
    case "image":
    case "imageReference": {
      const url = node.type === "image" ? node.url : resolve(node, ctx);
      const alt = node.alt || url || "";
      return url !== null && isHttpUrl(url) ? (
        link(url, alt, key)
      ) : (
        <Fragment key={key}>{alt}</Fragment>
      );
    }
    case "footnoteReference":
      return <Fragment key={key}>{`[^${node.label ?? node.identifier}]`}</Fragment>;
    default:
      return <Fragment key={key}>{plain(node)}</Fragment>;
  }
}

/** Renders block children, handing `tail` to the last one. */
function blocks(nodes: RootContent[], ctx: Ctx, depth: number, tail?: ReactNode): ReactNode[] {
  const shown = nodes.filter((n) => n.type !== "definition");
  return shown.map((n, i) => block(n, ctx, depth, i, i === shown.length - 1 ? tail : undefined));
}

function withTail(el: ReactNode, tail: ReactNode, key: number): ReactNode {
  if (tail === undefined) return el;
  return (
    <Fragment key={key}>
      {el}
      {tail}
    </Fragment>
  );
}

function listItems(list: List, ctx: Ctx, depth: number, tail?: ReactNode): ReactNode[] {
  return list.children.map((item, i) =>
    listItem(
      item,
      list.spread === true,
      ctx,
      depth,
      i,
      i === list.children.length - 1 ? tail : undefined,
    ),
  );
}

function listItem(
  item: ListItem,
  loose: boolean,
  ctx: Ctx,
  depth: number,
  key: number,
  tail?: ReactNode,
): ReactNode {
  const tight = !(loose || item.spread === true);
  const children = item.children.filter((n) => n.type !== "definition");
  const body = children.map((c, i) => {
    const t = i === children.length - 1 ? tail : undefined;
    if (tight && c.type === "paragraph") {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond order
        <Fragment key={i}>
          {phrasing(c.children, ctx, depth + 1)}
          {t}
        </Fragment>
      );
    }
    return block(c, ctx, depth + 1, i, t);
  });
  const task =
    typeof item.checked === "boolean" ? (
      <span className="cb-md-task" role="img" aria-label={ctx.taskLabel(item.checked)}>
        <Icon name={item.checked ? "check" : "square"} size={14} />
      </span>
    ) : null;
  return (
    <li key={key} data-task={task === null ? undefined : "true"}>
      {task}
      {body.length === 0 ? tail : body}
    </li>
  );
}

function table(node: Table, ctx: Ctx, depth: number, key: number, tail?: ReactNode): ReactNode {
  const [head, ...body] = node.children;
  const align = (i: number) => node.align?.[i] ?? undefined;
  const cells = (row: Table["children"][number], Tag: "th" | "td") =>
    row.children.map((c, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity beyond their column
      <Tag key={i} data-align={align(i)}>
        {phrasing(c.children, ctx, depth + 1)}
      </Tag>
    ));
  const shown = body.slice(0, MARKDOWN_TABLE_MAX_ROWS);
  const more = body.length - shown.length;
  return (
    <Fragment key={key}>
      <div className="cb-md-table-wrap">
        <table className="cb-md-table" data-part="md-table">
          {head ? (
            <thead data-part="md-table-head">
              <tr>{cells(head, "th")}</tr>
            </thead>
          ) : null}
          <tbody>
            {shown.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond order
              <tr key={i}>{cells(r, "td")}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? (
        <p className="cb-md-more" data-part="md-table-more">
          {ctx.moreRows(more)}
        </p>
      ) : null}
      {tail}
    </Fragment>
  );
}

const HEADING = { 1: "h3", 2: "h4", 3: "h5" } as const;

function block(
  node: RootContent,
  ctx: Ctx,
  depth: number,
  key: number,
  tail?: ReactNode,
): ReactNode {
  if (depth > MAX_DEPTH) return withTail(<p key={key}>{plain(node)}</p>, tail, key);
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key}>
          {phrasing(node.children, ctx, depth + 1)}
          {tail}
        </p>
      );
    case "heading": {
      const Tag = HEADING[node.depth as 1 | 2 | 3] ?? "h5";
      return (
        <Tag key={key} className="cb-md-h" data-part="prose-heading">
          {phrasing(node.children, ctx, depth + 1)}
          {tail}
        </Tag>
      );
    }
    case "thematicBreak":
      return withTail(<hr key={key} className="cb-md-hr" />, tail, key);
    case "blockquote":
      return (
        <blockquote key={key} className="cb-md-quote">
          {blocks(node.children, ctx, depth + 1, tail)}
        </blockquote>
      );
    case "list":
      return node.ordered ? (
        <ol key={key} start={node.start === 1 || node.start == null ? undefined : node.start}>
          {listItems(node, ctx, depth + 1, tail)}
        </ol>
      ) : (
        <ul key={key}>{listItems(node, ctx, depth + 1, tail)}</ul>
      );
    case "code":
      return withTail(
        <CodeBlock key={key} text={node.value} {...(node.lang ? { language: node.lang } : {})} />,
        tail,
        key,
      );
    case "html":
      return (
        <p key={key}>
          {node.value}
          {tail}
        </p>
      );
    case "table":
      return table(node, ctx, depth, key, tail);
    case "footnoteDefinition":
      return (
        <div key={key} className="cb-md-footnote">
          {`[^${node.label ?? node.identifier}]: `}
          {blocks(node.children, ctx, depth + 1, tail)}
        </div>
      );
    default:
      return withTail(<p key={key}>{plain(node)}</p>, tail, key);
  }
}

export function Markdown({ text, paths, onOpenPath, tail }: MarkdownProps): JSX.Element {
  const t = useDesignT();
  const tree = useMemo(() => parse(text), [text]);
  const defs = useMemo(() => {
    const m = new Map<string, Definition>();
    collectDefinitions(tree, m);
    return m;
  }, [tree]);
  const pathRe = useMemo(() => {
    if (!paths || paths.size === 0 || onOpenPath === undefined) return null;
    const list = [...paths].filter((p) => p !== "").sort((a, b) => b.length - a.length);
    return list.length === 0 ? null : new RegExp(list.map(escapeRe).join("|"), "g");
  }, [paths, onOpenPath]);
  const ctx: Ctx = {
    defs,
    paths: paths ?? new Set(),
    pathRe,
    onOpenPath,
    moreRows: (n) => (n === 1 ? t("conv.moreRow") : t("conv.moreRows").replace("{n}", String(n))),
    taskLabel: (done) => t(done ? "conv.taskDone" : "conv.taskTodo"),
  };
  const content = blocks(tree.children, ctx, 0, tail);
  return (
    <div className="cb-md" data-part="markdown">
      {content.length === 0 ? tail : content}
    </div>
  );
}
