"use client";

import {
  Checkbox,
  Field,
  FieldRow,
  FieldRowGroup,
  FormSection,
  Input,
  KeyValueEditor,
  Repeater,
  type RepeaterItem,
  Select,
} from "@capybara-hq/design";
import { type ReactNode, useState } from "react";
import { RefBlock } from "./ref-block";

// The config-form pieces (design spec §6.26–§6.28; config forms spec §6, the openai-compatible
// example): live blocks, so visual/repeater.interaction.spec.ts can add, remove, undo and reorder.

type Endpoint = { name: string; baseUrl: string };

const ENDPOINTS: Endpoint[] = [
  { name: "deepseek", baseUrl: "https://api.deepseek.com" },
  { name: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
];

const PRESETS: Record<string, Endpoint> = {
  deepseek: { name: "deepseek", baseUrl: "https://api.deepseek.com" },
  qwen: { name: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  ark: { name: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
};

const DIALECTS = [
  { value: "generic", label: "通用（vLLM 等）" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "qwen", label: "通义千问（百炼）" },
  { value: "ark", label: "火山方舟" },
];

/** Moves `key` to `to` in a keyed list. */
function moved<T>(list: T[], keyOf: (t: T) => string, key: string, to: number): T[] {
  const item = list.find((t) => keyOf(t) === key);
  if (!item) return list;
  const rest = list.filter((t) => keyOf(t) !== key);
  rest.splice(to, 0, item);
  return rest;
}

/** Removes `key` and returns the restore an undo calls. */
function removing<T>(
  set: (f: (l: T[]) => T[]) => void,
  keyOf: (t: T) => string,
  key: string,
): () => void {
  let snapshot: T[] = [];
  set((l) => {
    snapshot = l;
    return l.filter((t) => keyOf(t) !== key);
  });
  return () => set(() => snapshot);
}

function EndpointBody({ e, onChange }: { e: Endpoint; onChange(next: Endpoint): void }) {
  return (
    <>
      <Field label="名称" help="对外模型 ID 为 名称/模型 ID。">
        <Input value={e.name} onChange={(ev) => onChange({ ...e, name: ev.target.value })} />
      </Field>
      <Field label="接口地址">
        <Input
          value={e.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(ev) => onChange({ ...e, baseUrl: ev.target.value })}
        />
      </Field>
      <Field label="方言">
        <Select options={DIALECTS} defaultValue="generic" />
      </Field>
    </>
  );
}

function EndpointsDemo({
  initial,
  invalid,
  empty,
}: {
  initial: Endpoint[];
  invalid?: string;
  empty?: string;
}) {
  // Each row keeps a stable id; the name is what people edit.
  const [list, setList] = useState(() => initial.map((e, i) => ({ id: `e${i}`, ...e })));
  const [next, setNext] = useState(initial.length);
  const keyOf = (e: { id: string }) => e.id;
  const items: RepeaterItem[] = list.map((e) => ({
    key: e.id,
    title: e.name || "未命名端点",
    subtitle: e.baseUrl,
    invalid: e.name === invalid,
    body: (
      <EndpointBody
        e={e}
        onChange={(n) => setList((l) => l.map((x) => (x.id === e.id ? { ...x, ...n } : x)))}
      />
    ),
  }));
  return (
    <Repeater
      label="端点"
      addLabel="添加端点"
      items={items}
      min={1}
      {...(empty ? { empty, min: 0 } : {})}
      presets={[
        { id: "deepseek", label: "DeepSeek" },
        { id: "qwen", label: "通义千问（百炼）" },
        { id: "ark", label: "火山方舟" },
      ]}
      onAdd={(presetId) => {
        const preset = presetId ? PRESETS[presetId] : undefined;
        setList((l) => [...l, { id: `e${next}`, ...(preset ?? { name: "", baseUrl: "" }) }]);
        setNext((n) => n + 1);
      }}
      onRemove={(key) => removing(setList, keyOf, key)}
      onMove={(key, to) => setList((l) => moved(l, keyOf, key, to))}
    />
  );
}

type Model = {
  id: string;
  contextWindow: string;
  maxOutput: string;
  vision: boolean;
  reasoning: boolean;
};

const MODELS: Model[] = [
  {
    id: "deepseek-chat",
    contextWindow: "128000",
    maxOutput: "8192",
    vision: false,
    reasoning: false,
  },
  {
    id: "deepseek-reasoner",
    contextWindow: "128000",
    maxOutput: "32768",
    vision: false,
    reasoning: true,
  },
];

function ModelRow({
  m,
  first,
  onChange,
  defaultAdvancedOpen,
}: {
  m: Model;
  first: boolean;
  onChange(next: Model): void;
  defaultAdvancedOpen?: boolean;
}) {
  return (
    <FieldRow
      first={first}
      {...(defaultAdvancedOpen ? { defaultAdvancedOpen } : {})}
      advanced={
        <Field label="流空闲超时" optional>
          <Input placeholder="60000" suffix="毫秒" />
        </Field>
      }
    >
      <Field label="模型 ID">
        <Input
          value={m.id}
          placeholder="deepseek-chat"
          onChange={(e) => onChange({ ...m, id: e.target.value })}
        />
      </Field>
      <Field label="上下文窗口">
        <Input
          value={m.contextWindow}
          onChange={(e) => onChange({ ...m, contextWindow: e.target.value })}
        />
      </Field>
      <Field label="最大输出">
        <Input
          value={m.maxOutput}
          onChange={(e) => onChange({ ...m, maxOutput: e.target.value })}
        />
      </Field>
      <FieldRowGroup label="能力">
        <Checkbox checked={m.vision} label="图片" onChange={(v) => onChange({ ...m, vision: v })} />
        <Checkbox
          checked={m.reasoning}
          label="推理"
          onChange={(v) => onChange({ ...m, reasoning: v })}
        />
      </FieldRowGroup>
    </FieldRow>
  );
}

function ModelsDemo({ invalid }: { invalid?: string }) {
  const [list, setList] = useState(() => MODELS.map((m, i) => ({ key: `m${i}`, ...m })));
  const [next, setNext] = useState(MODELS.length);
  const keyOf = (m: { key: string }) => m.key;
  return (
    <Repeater
      label="模型"
      addLabel="添加模型"
      variant="rows"
      min={1}
      items={list.map((m, i) => ({
        key: m.key,
        title: m.id || `第 ${i + 1} 个模型`,
        invalid: m.id === invalid,
        body: (
          <ModelRow
            m={m}
            first={i === 0}
            onChange={(n) => setList((l) => l.map((x) => (x.key === m.key ? { ...x, ...n } : x)))}
          />
        ),
      }))}
      onAdd={() => {
        setList((l) => [
          ...l,
          {
            key: `m${next}`,
            id: "",
            contextWindow: "",
            maxOutput: "",
            vision: false,
            reasoning: false,
          },
        ]);
        setNext((n) => n + 1);
      }}
      onRemove={(key) => removing(setList, keyOf, key)}
      onMove={(key, to) => setList((l) => moved(l, keyOf, key, to))}
    />
  );
}

function repeaterBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="repeater-default" width={720} pad>
        <EndpointsDemo initial={ENDPOINTS} />
      </RefBlock>
      <RefBlock id="repeater-rows" width={720} pad>
        <ModelsDemo />
      </RefBlock>
      <RefBlock id="repeater-invalid" width={720} pad>
        <EndpointsDemo initial={[{ name: "", baseUrl: "https://api.deepseek.com" }]} invalid="" />
      </RefBlock>
      <RefBlock id="repeater-empty" width={720} pad>
        <EndpointsDemo initial={[]} empty="还没有端点。添加一个兼容 OpenAI 的服务即可开始。" />
      </RefBlock>
      {/* Inside a form card the cards are divided rows (spec §6.26, §1 "One box is enough"). */}
      <RefBlock id="repeater-divided" width={720} pad>
        <FormSection id="endpoints" title="端点" layout="stacked">
          <EndpointsDemo initial={ENDPOINTS} />
        </FormSection>
      </RefBlock>
    </>
  );
}

function StaticRows({ open }: { open?: boolean }) {
  return (
    <>
      {MODELS.map((m, i) => (
        <ModelRow
          key={m.id}
          m={m}
          first={i === 0}
          onChange={() => {}}
          {...(open && i === 0 ? { defaultAdvancedOpen: true } : {})}
        />
      ))}
    </>
  );
}

function fieldRowBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="field-row-first" width={720} pad>
        <StaticRows />
      </RefBlock>
      <RefBlock id="field-row-advanced-open" width={720} pad>
        <StaticRows open />
      </RefBlock>
      <RefBlock id="field-row-narrow" width={390} pad>
        <StaticRows />
      </RefBlock>
    </>
  );
}

function HeadersDemo({ initial, masked }: { initial: [string, string][]; masked?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <KeyValueEditor
      label={masked ? "API 密钥" : "请求头"}
      keyLabel="名称"
      valueLabel={masked ? "密钥" : "值"}
      value={value}
      onChange={setValue}
      maskValues={masked === true}
    />
  );
}

function keyValueEditorBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="key-value-editor-default" width={640} pad>
        <HeadersDemo
          initial={[
            ["X-Org", "acme"],
            ["X-Region", "cn-beijing"],
          ]}
        />
      </RefBlock>
      <RefBlock id="key-value-editor-masked" width={640} pad>
        <HeadersDemo initial={[["deepseek", "sk-0000000000"]]} masked />
      </RefBlock>
      <RefBlock id="key-value-editor-empty" width={640} pad>
        <HeadersDemo initial={[]} />
      </RefBlock>
    </>
  );
}

export const CONFIG_FORM_BLOCKS = {
  repeater: repeaterBlocks,
  "field-row": fieldRowBlocks,
  "key-value-editor": keyValueEditorBlocks,
} as const;
