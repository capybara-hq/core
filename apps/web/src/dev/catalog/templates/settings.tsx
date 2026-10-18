import {
  Field,
  FormSection,
  Input,
  Select,
  SettingsPage,
  Stack,
  Switch,
  Text,
} from "@capybara-hq/design";
import { useState } from "react";
import { FixtureShell } from "../frame";

const noop = () => {};

const NAV = [
  { id: "org", label: "组织", href: "/dev/ui/templates/settings" },
  { id: "env", label: "环境", href: "/dev/ui/templates/settings" },
  { id: "security", label: "安全", href: "/dev/ui/templates/settings" },
  { id: "members", label: "成员", href: "/dev/ui/templates/settings" },
  { id: "billing", label: "计费", href: "/dev/ui/templates/settings" },
];

function SettingsBody() {
  const [name, setName] = useState("示例组织");
  const [zone, setZone] = useState("utc8");
  const [mfa, setMfa] = useState(true);
  return (
    <SettingsPage
      header={{ title: "设置" }}
      nav={NAV}
      activeNav="org"
      actionRow={{
        unsaved: 1,
        cancel: { label: "取消", onSelect: noop },
        primary: { label: "保存", shortcut: "⌘S", onSelect: noop },
      }}
    >
      <FormSection id="org" title="组织信息" description="名称显示在顶栏与邀请邮件中。">
        <Field label="组织名称" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="时区" help="影响日志与计费周期的显示。">
          <Select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            options={[
              { value: "utc8", label: "UTC+8 北京" },
              { value: "utc", label: "UTC" },
            ]}
          />
        </Field>
      </FormSection>
      <FormSection id="security" title="安全" description="组织策略对所有成员生效。">
        <Stack direction="row" gap={12} align="center">
          <Switch label="要求两步验证" checked={mfa} onChange={setMfa} />
          <Text>要求两步验证</Text>
        </Stack>
      </FormSection>
    </SettingsPage>
  );
}

/** T5 设置：组织设置。 */
export function SettingsTemplate() {
  return (
    <FixtureShell nav="settings" context="settings/org">
      <SettingsBody />
    </FixtureShell>
  );
}
