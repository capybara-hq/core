import {
  Badge,
  Checkbox,
  Field,
  FormPage,
  FormSection,
  Input,
  RadioGroup,
  Select,
  Slider,
  Stack,
  Stepper,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useState } from "react";
import { FORM_ANCHORS, FORM_MODELS, FORM_PROMPT, FORM_TOOLS, FORM_TRIGGERS } from "../fixtures";
import { FixtureShell } from "../frame";

const noop = () => {};

function FormBody() {
  const [name, setName] = useState("kb-ingest");
  const [description, setDescription] = useState("把知识库文档切分、向量化并写入索引。");
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [temperature, setTemperature] = useState<number | undefined>(0.3);
  const [prompt, setPrompt] = useState(FORM_PROMPT);
  const [tools, setTools] = useState(
    () => new Set(FORM_TOOLS.filter((t) => t.on).map((t) => t.name)),
  );
  const [trigger, setTrigger] = useState("cron");
  const [concurrency, setConcurrency] = useState(4);
  const [approval, setApproval] = useState(true);
  const toggleTool = (n: string) =>
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <FormPage
      header={{
        parent: { label: "Agents", href: "/dev/ui/templates/list" },
        title: "新建 Agent",
        status: <Badge>草稿</Badge>,
        actions: [{ label: "从 YAML 导入", variant: "default" }],
      }}
      anchors={FORM_ANCHORS}
      actionRow={{
        unsaved: 2,
        errors: 1,
        cancel: { label: "取消", onSelect: noop },
        secondary: { label: "保存草稿", shortcut: "⌘S", onSelect: noop },
        primary: { label: "发布", onSelect: noop },
      }}
    >
      <FormSection id="basic" title="基本信息" description="名称用于 API 与日志，创建后不可修改。">
        <Field label="名称" required error="名称已存在，试试 kb-ingest-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="描述" optional count={{ value: description.length, max: 200 }}>
          <Textarea
            value={description}
            maxLength={200}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </FormSection>
      <FormSection id="model" title="模型与提示词" description="提示词对模型可见，请用英文书写。">
        <Field label="模型">
          <Select options={FORM_MODELS} value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label="温度">
          <Slider
            label="温度"
            value={temperature}
            min={0}
            max={1}
            step={0.1}
            withInput
            onChange={setTemperature}
          />
        </Field>
        <Field label="系统提示词" required>
          <Textarea code value={prompt} rows={4} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
      </FormSection>
      <FormSection id="tools" title="工具" description="只勾选需要的工具；写操作需要额外授权。">
        {FORM_TOOLS.map((t) => (
          <Stack key={t.name} gap={4}>
            <Checkbox
              checked={tools.has(t.name)}
              disabled={t.disabled}
              onChange={() => toggleTool(t.name)}
              label={
                <Stack direction="row" gap={8} align="center">
                  <Text tone={t.disabled ? "faint" : "ink"}>{t.name}</Text>
                  {t.tag ? <Badge>{t.tag}</Badge> : null}
                </Stack>
              }
            />
            <Text variant="small" tone={t.disabled ? "faint" : "muted"}>
              {t.description}
            </Text>
          </Stack>
        ))}
      </FormSection>
      <FormSection
        id="trigger"
        title="触发与治理"
        description="选择触发方式；高风险操作可要求人工审批。"
      >
        <RadioGroup
          label="触发方式"
          variant="card"
          value={trigger}
          onChange={setTrigger}
          options={FORM_TRIGGERS}
        />
        <Field label="并发上限">
          <Stepper
            label="并发上限"
            value={concurrency}
            min={1}
            max={16}
            onChange={setConcurrency}
          />
        </Field>
        <Checkbox checked={approval} onChange={setApproval} label="写入索引前需人工审批" />
        <Field label="所属环境" help="由组织策略锁定">
          <Input value="生产环境" suffix="[锁定]" disabled readOnly />
        </Field>
      </FormSection>
    </FormPage>
  );
}

/** T4 表单：新建 Agent（e-form）。 */
export function FormTemplate() {
  return (
    <FixtureShell nav="agents" context="agents/new">
      <FormBody />
    </FixtureShell>
  );
}
