import { Field, Grid, Input, Kbd, Select, Slider, Stepper, Textarea } from "@capybara-hq/design";
import { useState } from "react";
import { FORM_MODELS, FORM_PROMPT } from "../fixtures";
import { Section } from "../frame";

/** spec §6.2：Input / Select / Textarea / Stepper / Slider 与 Field 的各状态。 */
export function InputsSection() {
  const [concurrency, setConcurrency] = useState(4);
  const [minConcurrency, setMinConcurrency] = useState(1);
  const [temperature, setTemperature] = useState<number | undefined>(0.3);
  const [topP, setTopP] = useState<number | undefined>(undefined);
  const [maxTokens, setMaxTokens] = useState<number | undefined>(4096);
  return (
    <Section title="输入 Input / Select / Textarea" note="高 28；标签在上；错误信息在下">
      <Grid columns={4} gap={16}>
        <Field label="Agent 名称" help="默认">
          <Input placeholder="support-triage" />
        </Field>
        <Field label="Agent 名称" help="小写字母、数字与 -，创建后不可修改">
          <Input defaultValue="support-triage" />
        </Field>
        <Field label="Agent 名称" required error="名称已存在">
          <Input defaultValue="kb-ingest" />
        </Field>
        <Field label="Agent 名称" help="禁用">
          <Input defaultValue="support-triage" disabled />
        </Field>
        <Field label="模型" help="Select">
          <Select options={FORM_MODELS} defaultValue="claude-opus-5-5" />
        </Field>
        <Field label="模型" help="Select · 禁用">
          <Select options={FORM_MODELS} defaultValue="claude-opus-5-5" disabled />
        </Field>
        <Field label="搜索" help="带前缀 / 快捷键">
          <Input placeholder="搜索或执行命令" prefix=">" suffix={<Kbd>⌘K</Kbd>} />
        </Field>
        <Field label="所属环境" help="由组织策略锁定">
          <Input defaultValue="生产环境" suffix="[锁定]" disabled />
        </Field>
      </Grid>
      <Grid columns={2} gap={16}>
        <Field label="描述" optional count={{ value: 18, max: 200 }}>
          <Textarea defaultValue="把知识库文档切分、向量化并写入索引。" rows={3} />
        </Field>
        <Field label="系统提示词" required help="提示词对模型可见，请用英文书写。">
          <Textarea code defaultValue={FORM_PROMPT} rows={4} />
        </Field>
      </Grid>
      <Grid columns={3} gap={16}>
        <Field label="并发上限">
          <Stepper label="并发上限" value={concurrency} min={1} max={8} onChange={setConcurrency} />
        </Field>
        <Field label="并发上限" help="已到下限">
          <Stepper
            label="并发上限（下限）"
            value={minConcurrency}
            min={1}
            max={8}
            onChange={setMinConcurrency}
          />
        </Field>
        <Field label="并发上限" help="禁用">
          <Stepper label="并发上限（禁用）" value={4} disabled onChange={() => {}} />
        </Field>
        <Field label="温度" onReset={() => setTemperature(undefined)}>
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
        <Field label="Top P" help="未设置：拇指居中、轨道全灰">
          <Slider label="Top P" value={topP} min={0} max={1} step={0.05} onChange={setTopP} />
        </Field>
        <Field label="最大输出" help="禁用">
          <Slider
            label="最大输出"
            value={maxTokens}
            min={256}
            max={8192}
            step={256}
            disabled
            onChange={setMaxTokens}
          />
        </Field>
      </Grid>
    </Section>
  );
}
