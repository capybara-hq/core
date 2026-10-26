import { Card, Field, Input, RadioGroup, Stack, WizardPage } from "@capybara-hq/design";
import { useState } from "react";
import { FixtureShell } from "../frame";

const noop = () => {};

function WizardBody() {
  const [provider, setProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  return (
    <WizardPage
      header={{
        breadcrumb: [{ label: "设置", href: "/dev/ui/templates/settings" }],
        title: "接入模型",
      }}
      steps={["选择供应商", "填写凭据", "测试连接", "完成"]}
      current={1}
      actionRow={{
        cancel: { label: "取消", onSelect: noop },
        secondary: { label: "上一步", onSelect: noop },
        primary: { label: "下一步", shortcut: "↵", onSelect: noop },
      }}
    >
      <Card title="填写凭据">
        <Stack gap={16}>
          <RadioGroup
            label="供应商"
            variant="card"
            value={provider}
            onChange={setProvider}
            options={[
              {
                value: "anthropic",
                label: "Anthropic",
                description: "claude-opus-5-5 · claude-sonnet-5-5",
              },
              { value: "openai-compatible", label: "OpenAI 兼容", description: "自建或第三方网关" },
            ]}
          />
          <Field label="API Key" required help="只保存在服务端，界面上不再显示明文。">
            <Input
              type="password"
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
        </Stack>
      </Card>
    </WizardPage>
  );
}

/** T9 向导：首次接入模型。 */
export function WizardTemplate() {
  return (
    <FixtureShell nav="settings" context="settings/models/new">
      <WizardBody />
    </FixtureShell>
  );
}
