"use client";

import {
  Button,
  Checkbox,
  Disclosure,
  Field,
  FieldRow,
  FieldRowGroup,
  Input,
  KeyValueEditor,
  RadioGroup,
  Repeater,
  type RepeaterItem,
  Segmented,
  Select,
  Stack,
  Subsection,
  Switch,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConfigIssue, JsonSchema } from "../../lib/json-schema";
import { FormError } from "../form-error";
import {
  type ArrayNode,
  buildTree,
  type ConfigNode,
  type ConfigSecretEntry,
  type Draft,
  enclosingItem,
  type FieldMeta,
  fromDraft,
  type IssueText,
  type ItemDraft,
  type ItemSecretNode,
  itemText,
  itemTitle,
  mapIssues,
  type NodeProblem,
  newItemDraft,
  newItemKey,
  nodeId,
  type ObjectNode,
  type RecordNode,
  type ScalarNode,
  type SecretNode,
  type Segment,
  secretEntries,
  toDraft,
  within,
} from "./model";

export type { ConfigSecretEntry, FieldMeta, NodeProblem };

/** What the form reports on every change (and once on mount). */
export interface ConfigFormState {
  /** Client-side problems (required, type, limits); a save waits until there are none. */
  problems: NodeProblem[];
  /** The draft differs from the one the form opened with. */
  dirty: boolean;
}

/**
 * One renderer for every extension config form (extension config forms spec §5): deployment, org
 * and channel connection config, the catalog install wizard and the upgrade dialog. Draws the
 * JSON Schema's tree with its `x-ui` hints: nested objects as `Subsection`s (sections and an
 * "Advanced" disclosure; never a card inside the box the form sits in), arrays of objects as a
 * `Repeater` (divided rows inside a box; compact `FieldRow`s for `layout: "row"` items),
 * records as a `KeyValueEditor`, secrets as keep / replace / clear inputs, unions as JSON.
 *
 * `value` is where the form starts: it keeps its own draft and reports the value to save, the
 * secret entries of records drawn per item (deployment only) and its problems through
 * `onChange`; a caller resets it by remounting (a `key`). In the value, a secret left alone is
 * `undefined`, a cleared one `null`, a replaced one its new value.
 */
export function ConfigForm({
  schema,
  value,
  meta = {},
  issues = [],
  disabled = false,
  showRequired = false,
  onChange,
}: {
  schema: JsonSchema | null | undefined;
  value: unknown;
  meta?: Record<string, FieldMeta>;
  /** Server issues (the view's, or a failed save's); unmapped ones are listed above the form. */
  issues?: readonly ConfigIssue[];
  disabled?: boolean;
  /** Show missing required values before any edit (a wizard's Next was pressed). */
  showRequired?: boolean;
  onChange(value: unknown, secretEntries: ConfigSecretEntry[], state: ConfigFormState): void;
}) {
  const t = useTranslations("configForm");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const tree = useMemo(() => buildTree(schema, locale), [schema, locale]);
  const [baseline] = useState(() => toDraft(tree, value));
  const [draft, setDraft] = useState(baseline);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  // Items added in this session: their missing values stay quiet until the field was left.
  const fresh = useRef(new Set<string>());
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const touch = useCallback((segs: readonly Segment[]) => {
    const at = enclosingItem(draftRef.current, segs);
    if (at === null || !fresh.current.has(at.key)) return;
    setSeen((prev) => {
      const id = `${at.key}|${at.rel}`;
      if (prev.has(id)) return prev;
      return new Set(prev).add(id);
    });
  }, []);
  const result = useMemo(
    () => fromDraft(tree, draft, { secretSet: (p) => metaRef.current[p]?.secretSet === true }),
    [tree, draft],
  );
  const entries = useMemo(
    () => secretEntries(tree, draft, baseline, metaRef.current),
    [tree, draft, baseline],
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // ssr-exempt: reports the draft to the caller (no fetch)
  useEffect(() => {
    onChangeRef.current(result.value, entries, {
      problems: result.problems,
      dirty: draft !== baseline,
    });
  }, [result, entries, draft, baseline]);

  // Server issues in the page's words: the kernel's generated English never reaches the form.
  const issueWords = (x: IssueText): string =>
    x.limit !== undefined ? t(`errors.${x.key}`, { limit: x.limit }) : t(`errors.${x.key}`);
  const issueWordsRef = useRef(issueWords);
  issueWordsRef.current = issueWords;
  const mapped = useMemo(
    () => mapIssues(tree, result.value, issues, (x) => issueWordsRef.current(x)),
    [tree, result, issues],
  );
  const ctx: Ctx = {
    meta,
    disabled,
    value: result.value,
    messages: new Map(mapped.byNode),
    fresh: fresh.current,
    touch,
  };
  // Client problems: type and limit problems at once, missing values (an empty field, a list
  // without its items) once the person edited.
  const pristine = draft === baseline && !showRequired;
  for (const p of result.problems) {
    if (ctx.messages.has(p.id) || (pristine && (p.kind === "required" || p.kind === "minItems")))
      continue;
    if ((p.kind === "required" || p.kind === "minItems") && !showRequired) {
      const at = enclosingItem(draft, p.segments);
      if (at !== null && fresh.current.has(at.key) && !seen.has(`${at.key}|${at.rel}`)) continue;
    }
    ctx.messages.set(p.id, problemText(p));
  }
  function problemText(p: NodeProblem): string {
    if (p.kind === "minItems" && p.limit === 1) return t("errors.addOne");
    return issueWords(p.limit !== undefined ? { key: p.kind, limit: p.limit } : { key: p.kind });
  }

  if (tree.children.length === 0) return null;
  return (
    <Stack gap={16}>
      {mapped.form.length > 0 && <FormError message={t("issues")} extra={mapped.form} />}
      <Root node={tree} draft={draft} set={setDraft} ctx={ctx} />
    </Stack>
  );
}

interface Ctx {
  meta: Record<string, FieldMeta>;
  disabled: boolean;
  /** The current value (item titles, keys). */
  value: unknown;
  /** Messages per node id: server issues, then client problems. */
  messages: Map<string, string>;
  /** Keys of the items added since the form opened. */
  fresh: Set<string>;
  /** A field was left (or picked): its missing-value message may show. */
  touch(segs: readonly Segment[]): void;
}

/**
 * Sets a node's draft: a draft, or an update of the latest one. Every level composes updates
 * functionally, so a late call (an undo toast's restore) never rebuilds ancestors from an old
 * render and keeps the edits made since.
 */
type DraftUpdate = Draft | ((prev: Draft) => Draft);
type SetDraft = (next: DraftUpdate) => void;

const apply = (u: DraftUpdate, prev: Draft): Draft => (typeof u === "function" ? u(prev) : u);

const itemsOf = (d: Draft): ItemDraft[] => (d.t === "array" ? d.items : []);

/** The setter of an object's child `c`, applied to the latest object draft. */
const childSetter =
  (set: SetDraft, c: ConfigNode): SetDraft =>
  (u) =>
    set((prev) => {
      const fields = prev.t === "object" ? prev.fields : {};
      const cur = fields[c.key] ?? toDraft(c, undefined);
      return { t: "object", fields: { ...fields, [c.key]: apply(u, cur) } };
    });

const hasMessageIn = (ctx: Ctx, id: string) => [...ctx.messages.keys()].some((k) => within(k, id));

const valueAt = (value: unknown, segs: readonly Segment[]): unknown => {
  let at = value;
  for (const s of segs) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[s];
  }
  return at;
};

/** The node is its config field's own node (not a part of an array's items). */
const isFieldRoot = (node: ConfigNode, segs: readonly Segment[]) =>
  segs.every((s) => typeof s === "string") && segs.join(".") === node.fieldPath;

function Root({
  node,
  draft,
  set,
  ctx,
}: {
  node: ObjectNode;
  draft: Draft;
  set: SetDraft;
  ctx: Ctx;
}) {
  const plain = node.children.filter(
    (c) => c.section === undefined || !node.sections.some((s) => s.id === c.section),
  );
  return (
    <Stack gap={24}>
      {plain.length > 0 && (
        <Children node={node} only={plain} draft={draft} set={set} segs={[]} ctx={ctx} />
      )}
      {node.sections.map((s) => {
        const only = node.children.filter((c) => c.section === s.id);
        if (only.length === 0) return null;
        return (
          <Stack key={s.id} gap={12}>
            <Stack gap={4}>
              <Text variant="h3">{s.label}</Text>
              {s.help !== undefined && (
                <Text variant="small" tone="muted">
                  {s.help}
                </Text>
              )}
            </Stack>
            <Children node={node} only={only} draft={draft} set={set} segs={[]} ctx={ctx} />
          </Stack>
        );
      })}
    </Stack>
  );
}

const fieldsOf = (draft: Draft): Record<string, Draft> =>
  draft.t === "object" ? draft.fields : {};

/** An object's children stacked, the `advanced` ones under an "Advanced" disclosure. */
function Children({
  node,
  only,
  draft,
  set,
  segs,
  ctx,
}: {
  node: ObjectNode;
  only?: ConfigNode[];
  draft: Draft;
  set: SetDraft;
  segs: Segment[];
  ctx: Ctx;
}) {
  const t = useTranslations("configForm");
  const fields = fieldsOf(draft);
  const children = only ?? node.children;
  const draw = (c: ConfigNode) => (
    <Node
      key={c.key}
      node={c}
      draft={fields[c.key] ?? toDraft(c, undefined)}
      set={childSetter(set, c)}
      segs={[...segs, c.key]}
      itemFields={fields}
      ctx={ctx}
    />
  );
  const main = children.filter((c) => !c.advanced);
  const advanced = children.filter((c) => c.advanced);
  return (
    <Stack gap={16}>
      {main.map(draw)}
      {advanced.length > 0 && (
        <Disclosure
          summary={t("advanced")}
          defaultOpen={advanced.some((c) => hasMessageIn(ctx, nodeId([...segs, c.key])))}
        >
          <Stack gap={16}>{advanced.map(draw)}</Stack>
        </Disclosure>
      )}
    </Stack>
  );
}

interface NodeProps {
  node: ConfigNode;
  draft: Draft;
  set: SetDraft;
  segs: Segment[];
  ctx: Ctx;
  /** The enclosing object's drafts (an item secret reads its item's key field). */
  itemFields?: Record<string, Draft>;
}

/** Help line: the hint's help, the read-only source and the "applies immediately" note. */
function useHelp(node: ConfigNode, segs: Segment[], ctx: Ctx): string | undefined {
  const t = useTranslations("configForm");
  const m = ctx.meta[node.fieldPath];
  const own = isFieldRoot(node, segs);
  const parts = [
    node.help,
    own && m?.readonly !== undefined ? t("readonly", { source: m.readonly }) : undefined,
    own && m?.readonly === undefined && m?.hot === true ? t("hot") : undefined,
  ].filter((s): s is string => s !== undefined && s !== "");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const isLocked = (node: ConfigNode, ctx: Ctx) =>
  ctx.disabled || ctx.meta[node.fieldPath]?.readonly !== undefined;

function Node(props: NodeProps) {
  const { node, draft, set, segs, ctx } = props;
  switch (node.kind) {
    case "object":
      // A nested object is a subsection of the box it sits in (spec §1 "One box is enough",
      // §6.32): its title as an h3, its help, its fields under the guide; never a Card.
      return (
        <Subsection title={node.label} {...(node.help !== undefined && { description: node.help })}>
          <Children node={node} draft={draft} set={set} segs={segs} ctx={ctx} />
        </Subsection>
      );
    case "array":
      return node.item.kind === "object" ? (
        <ArrayField {...props} node={node} />
      ) : (
        <LinesField {...props} node={node} />
      );
    case "record":
      return <RecordField {...props} node={node} />;
    case "secret":
      return <SecretField {...props} node={node} />;
    case "itemSecret":
      return <ItemSecretField {...props} node={node} />;
    case "json":
      return <JsonField {...props} />;
    case "scalar":
      return <ScalarField {...props} node={node} />;
  }
}

/** A Field with the node's label, help and message. */
function NodeField({
  node,
  segs,
  ctx,
  children,
  help,
}: {
  node: ConfigNode;
  segs: Segment[];
  ctx: Ctx;
  children: ReactElement<Record<string, unknown>>;
  help?: string | undefined;
}) {
  const own = useHelp(node, segs, ctx);
  const error = ctx.messages.get(nodeId(segs));
  const text = [own, help].filter(Boolean).join(" · ");
  return (
    <Field
      label={node.label}
      required={node.required && node.default === undefined}
      {...(text !== "" && { help: text })}
      {...(error !== undefined && { error })}
    >
      {children}
    </Field>
  );
}

function ScalarField({ node, draft, set, segs, ctx }: NodeProps & { node: ScalarNode }) {
  const t = useTranslations("configForm");
  const off = isLocked(node, ctx);
  const help = useHelp(node, segs, ctx);
  const error = ctx.messages.get(nodeId(segs));
  const text = draft.t === "text" ? draft.text : "";
  const bool = draft.t === "bool" ? draft.value : undefined;
  if (node.options !== undefined) {
    const options = node.options;
    if (node.widget === "radio")
      return (
        <NodeField node={node} segs={segs} ctx={ctx}>
          <RadioGroup
            label={node.label}
            value={text}
            disabled={off}
            onChange={(v) => set({ t: "text", text: v })}
            options={options.map((o) => ({
              value: o.token,
              label: o.label,
              ...(o.help !== undefined && { description: o.help }),
            }))}
          />
        </NodeField>
      );
    const chosen = options.find((o) => o.token === text);
    return (
      <NodeField node={node} segs={segs} ctx={ctx} help={chosen?.help}>
        <Select
          value={text}
          disabled={off}
          onChange={(e) => {
            set({ t: "text", text: e.target.value });
            ctx.touch(segs);
          }}
          options={[
            ...(text === "" || !(node.required && node.default === undefined)
              ? [{ value: "", label: t("none") }]
              : []),
            ...options.map((o) => ({ value: o.token, label: o.label })),
          ]}
        />
      </NodeField>
    );
  }
  if (node.type === "boolean") {
    if (node.widget === "checkbox") {
      return (
        <Stack gap={4}>
          <Checkbox
            label={node.label}
            checked={bool === true}
            disabled={off}
            onChange={(v) => set({ t: "bool", value: v })}
          />
          {error !== undefined ? (
            <Text variant="small" tone="fail" icon="circle-alert">
              {error}
            </Text>
          ) : help !== undefined ? (
            <Text variant="small" tone="muted">
              {help}
            </Text>
          ) : null}
        </Stack>
      );
    }
    if (node.widget === "tristate") {
      const v = bool === undefined ? "default" : bool ? "on" : "off";
      const opts = [
        { value: "default", label: t("tristate.default") },
        { value: "on", label: t("tristate.on") },
        { value: "off", label: t("tristate.off") },
      ];
      const pick = (x: string) =>
        set({ t: "bool", value: x === "default" ? undefined : x === "on" });
      return (
        <NodeField node={node} segs={segs} ctx={ctx}>
          {off ? (
            <Select value={v} disabled options={opts} onChange={() => {}} />
          ) : (
            <Segmented fill label={node.label} value={v} options={opts} onChange={pick} />
          )}
        </NodeField>
      );
    }
    return (
      <NodeField node={node} segs={segs} ctx={ctx}>
        <Switch
          label={node.label}
          checked={bool === true}
          disabled={off}
          onChange={(v) => set({ t: "bool", value: v })}
        />
      </NodeField>
    );
  }
  if (node.widget === "textarea") {
    return (
      <NodeField node={node} segs={segs} ctx={ctx}>
        <Textarea
          rows={4}
          value={text}
          disabled={off}
          {...(node.placeholder !== undefined && { placeholder: node.placeholder })}
          onChange={(e) => set({ t: "text", text: e.target.value })}
          onBlur={() => ctx.touch(segs)}
        />
      </NodeField>
    );
  }
  const numeric = node.type === "number" || node.type === "integer";
  return (
    <NodeField node={node} segs={segs} ctx={ctx}>
      <Input
        type={numeric ? "text" : node.widget === "url" ? "url" : "text"}
        {...(numeric && { inputMode: node.type === "integer" ? "numeric" : "decimal" })}
        spellCheck={false}
        value={text}
        disabled={off}
        {...(node.placeholder !== undefined && { placeholder: node.placeholder })}
        {...(node.unit !== undefined && { suffix: node.unit })}
        onChange={(e) => set({ t: "text", text: e.target.value })}
        onBlur={() => ctx.touch(segs)}
      />
    </NodeField>
  );
}

function JsonField({ node, draft, set, segs, ctx }: NodeProps) {
  const t = useTranslations("configForm");
  return (
    <NodeField
      node={node}
      segs={segs}
      ctx={ctx}
      help={node.help === undefined ? t("jsonHint") : undefined}
    >
      <Textarea
        code
        rows={4}
        value={draft.t === "text" ? draft.text : ""}
        disabled={isLocked(node, ctx)}
        onChange={(e) => set({ t: "text", text: e.target.value })}
        onBlur={() => ctx.touch(segs)}
      />
    </NodeField>
  );
}

function LinesField({ node, draft, set, segs, ctx }: NodeProps & { node: ArrayNode }) {
  const t = useTranslations("configForm");
  return (
    <NodeField node={node} segs={segs} ctx={ctx} help={t("linesHint")}>
      <Textarea
        rows={3}
        value={draft.t === "text" ? draft.text : ""}
        disabled={isLocked(node, ctx)}
        {...(node.placeholder !== undefined && { placeholder: node.placeholder })}
        onChange={(e) => set({ t: "text", text: e.target.value })}
        onBlur={() => ctx.touch(segs)}
      />
    </NodeField>
  );
}

/** A group's visible label, help and message around a control that is no single input. */
function Group({
  node,
  segs,
  ctx,
  children,
}: {
  node: ConfigNode;
  segs: Segment[];
  ctx: Ctx;
  children: ReactNode;
}) {
  const help = useHelp(node, segs, ctx);
  const error = ctx.messages.get(nodeId(segs));
  return (
    <Stack gap={8}>
      <Stack gap={4}>
        <Text>
          {node.label}
          {node.required && node.default === undefined ? " *" : ""}
        </Text>
        {help !== undefined && (
          <Text variant="small" tone="muted">
            {help}
          </Text>
        )}
      </Stack>
      {children}
      {error !== undefined && (
        <Text variant="small" tone="fail" icon="circle-alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}

function RecordField({ node, draft, set, segs, ctx }: NodeProps & { node: RecordNode }) {
  const t = useTranslations("configForm");
  return (
    <Group node={node} segs={segs} ctx={ctx}>
      <KeyValueEditor
        label={node.label}
        keyLabel={t("key")}
        valueLabel={t("value")}
        value={draft.t === "record" ? draft.rows : []}
        disabled={isLocked(node, ctx)}
        onChange={(rows) => set({ t: "record", rows })}
      />
    </Group>
  );
}

/** Moves `key` to index `to`. */
function moved<T extends { key: string }>(list: T[], key: string, to: number): T[] {
  const item = list.find((x) => x.key === key);
  if (!item) return list;
  const rest = list.filter((x) => x.key !== key);
  rest.splice(to, 0, item);
  return rest;
}

function ArrayField({ node, draft, set, segs, ctx }: NodeProps & { node: ArrayNode }) {
  const t = useTranslations("configForm");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const items = draft.t === "array" ? draft.items : [];
  const item = node.item as ObjectNode;
  const rows = item.layout === "row";
  const off = isLocked(node, ctx);
  const values = valueAt(ctx.value, segs);
  const list: RepeaterItem[] = items.map((it, i) => {
    const id = nodeId([...segs, i]);
    const itemValue = Array.isArray(values) ? values[i] : undefined;
    const invalid = hasMessageIn(ctx, id);
    const setItem: SetDraft = (u) =>
      set((prev) => ({
        t: "array",
        items: itemsOf(prev).map((x) =>
          x.key === it.key ? { ...x, draft: apply(u, x.draft) } : x,
        ),
      }));
    const body = rows ? (
      <ItemRow
        key={it.key}
        node={item}
        draft={it.draft}
        set={setItem}
        segs={[...segs, i]}
        ctx={ctx}
        first={i === 0}
      />
    ) : (
      <Children
        key={it.key}
        node={item}
        draft={it.draft}
        set={setItem}
        segs={[...segs, i]}
        ctx={ctx}
      />
    );
    const title = itemTitle(node, itemValue) || t("itemN", { n: i + 1 });
    const subtitle = itemText(node.subtitle, itemValue);
    return {
      key: it.key,
      title,
      ...(subtitle !== "" && { subtitle }),
      body,
      ...(invalid && { invalid: true }),
      ...(!rows && { collapsed: collapsed.has(it.key) && !invalid }),
    };
  });
  return (
    <Group node={node} segs={segs} ctx={ctx}>
      <Repeater
        label={node.label}
        variant={rows ? "rows" : "cards"}
        items={list}
        addLabel={node.addLabel ?? (node.label ? t("addNamed", { label: node.label }) : t("add"))}
        disabled={off}
        {...(node.minItems !== undefined && { min: node.minItems })}
        {...(node.maxItems !== undefined && { max: node.maxItems })}
        {...(node.presets.length > 0 && {
          presets: node.presets.map((p) => ({
            id: p.id,
            label: p.label,
            ...(p.help !== undefined && { help: p.help }),
          })),
        })}
        onAdd={(presetId) => {
          const preset = node.presets.find((p) => p.id === presetId);
          const added = { key: newItemKey(), draft: newItemDraft(node, preset?.values) };
          ctx.fresh.add(added.key);
          set((prev) => ({ t: "array", items: [...itemsOf(prev), added] }));
        }}
        onRemove={(key) => {
          let removed: ItemDraft | undefined;
          let at = 0;
          set((prev) => {
            const list = itemsOf(prev);
            at = list.findIndex((x) => x.key === key);
            removed = list[at];
            return { t: "array", items: list.filter((x) => x.key !== key) };
          });
          // Put the item back into the latest list (edits made since stay).
          return () =>
            set((prev) => {
              const list = itemsOf(prev);
              if (removed === undefined || list.some((x) => x.key === key)) return prev;
              const next = [...list];
              next.splice(Math.min(Math.max(at, 0), next.length), 0, removed);
              return { t: "array", items: next };
            });
        }}
        {...(node.reorder && {
          onMove: (key: string, to: number) =>
            set((prev) => ({ t: "array", items: moved(itemsOf(prev), key, to) })),
        })}
        {...(!rows && {
          onToggle: (key: string) =>
            setCollapsed((s) => {
              const next = new Set(s);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            }),
        })}
      />
    </Group>
  );
}

/** One item of a `layout: "row"` array: a FieldRow, checkboxes grouped, advanced fields behind its toggle. */
function ItemRow({
  node,
  draft,
  set,
  segs,
  ctx,
  first,
}: {
  node: ObjectNode;
  draft: Draft;
  set: SetDraft;
  segs: Segment[];
  ctx: Ctx;
  first: boolean;
}) {
  const t = useTranslations("configForm");
  const fields = fieldsOf(draft);
  const props = (c: ConfigNode): NodeProps => ({
    node: c,
    draft: fields[c.key] ?? toDraft(c, undefined),
    set: childSetter(set, c),
    segs: [...segs, c.key],
    itemFields: fields,
    ctx,
  });
  const isBox = (c: ConfigNode) => c.kind === "scalar" && c.widget === "checkbox";
  const main = node.children.filter((c) => !c.advanced);
  const advanced = node.children.filter((c) => c.advanced);
  // Consecutive checkboxes form one group; their messages go under the row.
  const parts: ReactNode[] = [];
  for (let i = 0; i < main.length; i++) {
    const c = main[i] as ConfigNode;
    if (!isBox(c)) {
      parts.push(<Node key={c.key} {...props(c)} />);
      continue;
    }
    const boxes: ConfigNode[] = [];
    while (i < main.length && isBox(main[i] as ConfigNode)) boxes.push(main[i++] as ConfigNode);
    i--;
    const draw = (b: ConfigNode) => (
      <RowCheckbox key={b.key} {...props(b)} node={b as ScalarNode} />
    );
    parts.push(
      boxes.length === 1 ? (
        draw(boxes[0] as ConfigNode)
      ) : (
        <FieldRowGroup key={`group-${boxes[0]?.key}`} label={t("options")}>
          {boxes.map(draw)}
        </FieldRowGroup>
      ),
    );
  }
  const boxMessages = node.children.filter(isBox).flatMap((b) => {
    const m = ctx.messages.get(nodeId([...segs, b.key]));
    return m === undefined ? [] : [`${b.label}: ${m}`];
  });
  const openAdvanced = advanced.some((c) => hasMessageIn(ctx, nodeId([...segs, c.key])));
  return (
    <Stack gap={4}>
      <FieldRow
        first={first}
        {...(openAdvanced && { defaultAdvancedOpen: true })}
        {...(advanced.length > 0 && {
          advanced: advanced.map((c) => <Node key={c.key} {...props(c)} />),
        })}
      >
        {parts}
      </FieldRow>
      {boxMessages.map((m) => (
        <Text key={m} variant="small" tone="fail" icon="circle-alert">
          {m}
        </Text>
      ))}
    </Stack>
  );
}

function RowCheckbox({ node, draft, set, ctx }: NodeProps & { node: ScalarNode }) {
  return (
    <Checkbox
      label={node.label}
      checked={draft.t === "bool" && draft.value === true}
      disabled={isLocked(node, ctx)}
      onChange={(v) => set({ t: "bool", value: v })}
    />
  );
}

/**
 * A secret input. Not set yet: a password input. Set: a read-only input showing "set" with
 * Replace (then a new value) and Clear (unless required); undo returns to keeping it.
 */
function SecretControl({
  label,
  required,
  help,
  error,
  placeholder,
  existing,
  locked,
  disabled,
  op,
  text,
  onChange,
  editor,
}: {
  label: string;
  required: boolean;
  help?: string | undefined;
  error?: string | undefined;
  placeholder?: string | undefined;
  existing: boolean;
  locked: boolean;
  disabled: boolean;
  op: "keep" | "clear" | "set";
  text: string;
  onChange(op: "keep" | "clear" | "set", text: string): void;
  /** Replaces the password input while setting (a record's key / value rows). */
  editor?: ReactNode;
}) {
  const t = useTranslations("configForm");
  const common = {
    label,
    required,
    ...(help !== undefined && { help }),
    ...(error !== undefined && { error }),
  };
  if (locked) {
    return (
      <Field {...common}>
        <Input
          type="password"
          autoComplete="off"
          value=""
          placeholder={existing ? t("secretSet") : ""}
          disabled
          onChange={() => {}}
        />
      </Field>
    );
  }
  if (!existing || op === "set") {
    if (editor !== undefined && (op === "set" || !existing)) {
      return (
        <Stack gap={8}>
          <Text>{label}</Text>
          {editor}
          {existing && (
            <Stack direction="row">
              <Button density="dense" disabled={disabled} onClick={() => onChange("keep", "")}>
                {t("cancelReplace")}
              </Button>
            </Stack>
          )}
        </Stack>
      );
    }
    if (!existing) {
      return (
        <Field {...common}>
          <Input
            type="password"
            autoComplete="new-password"
            value={text}
            disabled={disabled}
            {...(placeholder !== undefined && { placeholder })}
            onChange={(e) => onChange("set", e.target.value)}
          />
        </Field>
      );
    }
  }
  const replacing = op === "set";
  const clearing = op === "clear";
  return (
    <Stack gap={8}>
      <Field {...common}>
        <Input
          type="password"
          autoComplete="new-password"
          value={replacing ? text : ""}
          placeholder={clearing ? t("secretWillClear") : replacing ? "" : t("secretSet")}
          disabled={disabled || !replacing}
          onChange={(e) => onChange("set", e.target.value)}
        />
      </Field>
      <Stack direction="row" gap={8}>
        {replacing || clearing ? (
          <Button
            density="dense"
            disabled={disabled}
            aria-label={t(replacing ? "cancelReplaceLabel" : "undoClearLabel", { field: label })}
            onClick={() => onChange("keep", "")}
          >
            {t(replacing ? "cancelReplace" : "undoClear")}
          </Button>
        ) : (
          <>
            <Button
              density="dense"
              disabled={disabled}
              aria-label={t("replaceLabel", { field: label })}
              onClick={() => onChange("set", "")}
            >
              {t("replace")}
            </Button>
            {!required && (
              <Button
                density="dense"
                variant="danger"
                disabled={disabled}
                aria-label={t("clearLabel", { field: label })}
                onClick={() => onChange("clear", "")}
              >
                {t("clear")}
              </Button>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}

function SecretField({ node, draft, set, segs, ctx }: NodeProps & { node: SecretNode }) {
  const t = useTranslations("configForm");
  const help = useHelp(node, segs, ctx);
  const d =
    draft.t === "secret"
      ? draft
      : { t: "secret" as const, op: "keep" as const, text: "", rows: [] };
  const existing = ctx.meta[node.fieldPath]?.secretSet === true;
  const editor =
    node.shape === "record" ? (
      <KeyValueEditor
        label={node.label}
        keyLabel={t("key")}
        valueLabel={t("value")}
        value={d.rows}
        maskValues
        disabled={ctx.disabled}
        onChange={(rows) => set({ ...d, op: "set", rows })}
      />
    ) : undefined;
  return (
    <SecretControl
      label={node.label}
      required={node.required && node.default === undefined}
      help={node.shape === "json" ? [help, t("jsonHint")].filter(Boolean).join(" · ") : help}
      error={ctx.messages.get(nodeId(segs))}
      placeholder={node.placeholder}
      existing={existing}
      locked={ctx.meta[node.fieldPath]?.readonly !== undefined}
      disabled={ctx.disabled}
      op={d.op}
      text={d.text}
      onChange={(op, text) => set({ ...d, op, text, rows: op === "set" ? d.rows : [] })}
      {...(editor !== undefined && { editor })}
    />
  );
}

function ItemSecretField({
  node,
  draft,
  set,
  segs,
  ctx,
  itemFields = {},
}: NodeProps & { node: ItemSecretNode }) {
  const d =
    draft.t === "itemSecret"
      ? draft
      : { t: "itemSecret" as const, op: "keep" as const, text: "", origKey: undefined };
  const keys = ctx.meta[node.path]?.secretKeys ?? [];
  const existing = d.origKey !== undefined && keys.includes(d.origKey);
  const name = itemFields[node.keyBy];
  const locked = ctx.meta[node.path]?.readonly !== undefined;
  return (
    <SecretControl
      label={node.label}
      required={false}
      help={node.help}
      error={ctx.messages.get(nodeId(segs))}
      placeholder={node.placeholder}
      existing={existing}
      locked={locked}
      disabled={ctx.disabled || (name?.t === "text" && name.text === "" && !existing)}
      op={d.op}
      text={d.text}
      onChange={(op, text) => set({ ...d, op, text })}
    />
  );
}
