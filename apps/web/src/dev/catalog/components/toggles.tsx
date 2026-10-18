import { Checkbox, Grid, RadioGroup, Stack, Switch, Text } from "@capybara-hq/design";
import { useState } from "react";
import { FORM_TRIGGERS } from "../fixtures";
import { Row, Section } from "../frame";

const noop = () => {};

/** spec §6.3：复选 / 单选 / 开关 / 选项卡片，全部方形。 */
export function TogglesSection() {
  const [plain, setPlain] = useState("webhook");
  const [card, setCard] = useState("cron");
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  return (
    <Section title="选择控件" note="全部方形，与字符网格对齐">
      <Row label="复选框">
        <Checkbox checked={false} onChange={noop} label="未选" />
        <Checkbox checked onChange={noop} label="选中" />
        <Checkbox checked="indeterminate" onChange={noop} label="半选" />
        <Checkbox checked={false} disabled onChange={noop} label="禁用" />
        <Checkbox checked disabled onChange={noop} label="禁用 · 选中" />
      </Row>
      <Row label="单选">
        <RadioGroup
          label="触发方式"
          value={plain}
          onChange={setPlain}
          options={FORM_TRIGGERS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <RadioGroup
          label="触发方式（禁用）"
          value="webhook"
          disabled
          onChange={noop}
          options={FORM_TRIGGERS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Row>
      <Row label="开关">
        <Stack direction="row" gap={8} align="center">
          <Switch label="开" checked={on} onChange={setOn} />
          <Text variant="small" tone="muted">
            开
          </Text>
        </Stack>
        <Stack direction="row" gap={8} align="center">
          <Switch label="关" checked={off} onChange={setOff} />
          <Text variant="small" tone="muted">
            关
          </Text>
        </Stack>
        <Stack direction="row" gap={8} align="center">
          <Switch label="禁用" checked disabled onChange={noop} />
          <Text variant="small" tone="muted">
            禁用
          </Text>
        </Stack>
      </Row>
      <Row label="选项卡片">
        <Grid columns={1} gap={8}>
          <RadioGroup
            label="触发方式（卡片）"
            variant="card"
            value={card}
            onChange={setCard}
            options={FORM_TRIGGERS}
          />
        </Grid>
      </Row>
    </Section>
  );
}
