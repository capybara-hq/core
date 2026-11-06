import {
  AgentMapDialog,
  Card,
  CommandPalette,
  DataTable,
  FormSection,
  Menu,
  Sheet,
  TranscriptFrame,
} from "@capybara-hq/design";
import type { ReactNode } from "react";
import { usePurposeEditor } from "./use-editor";

function renderCard() {
  return <Card title="helper">一</Card>;
}

function useLocalEditor() {
  return { local: (i: number) => <Card title="e">{i}</Card> };
}

function Renamed({ children: body }: { children?: ReactNode }) {
  return <Card title="外框">{body}</Card>;
}

function Slotted({ aside, label }: { aside?: ReactNode; label: string }) {
  return (
    <section aria-label={label}>
      <Card title="边栏">{aside}</Card>
    </section>
  );
}

function PropsObject(props: { footer?: ReactNode }) {
  return <Card title="脚注">{props.footer}</Card>;
}

const Cell = () => <Card title="单元格">二</Card>;

export function Followed({ items }: { items: string[] }) {
  const cards = items.map((i) => (
    <Card key={i} title={i}>
      三
    </Card>
  ));
  const { editor } = usePurposeEditor();
  const { local } = useLocalEditor();
  return (
    <>
      <FormSection id="a" title="变量">
        {cards}
      </FormSection>
      <Card title="外">{renderCard()}</Card>
      <FormSection id="b" title="钩子">
        {editor(1)}
        {[1, 2].map(local)}
      </FormSection>
      <Renamed>
        <Card title="改名">四</Card>
      </Renamed>
      <Slotted label="槽" aside={<Card title="槽位">五</Card>} />
      <PropsObject footer={<Card title="对象">六</Card>} />
      <Sheet open onOpenChange={() => {}} title="侧板">
        <DataTable
          label="表"
          columns={[{ key: "a", header: "a", cell: () => <Cell /> }]}
          rows={[]}
          rowKey={() => ""}
        />
      </Sheet>
      <AgentMapDialog open onOpenChange={() => {}}>
        <Card title="直接">七</Card>
      </AgentMapDialog>
    </>
  );
}

export function Portals({ items }: { items: string[] }) {
  const label = items.join("、");
  return (
    <Card title="外">
      <Menu trigger={<button type="button">{label}</button>} items={[]}>
        <Card title="菜单里">八</Card>
      </Menu>
      <CommandPalette open onOpenChange={() => {}} items={[]}>
        <Card title="面板里">九</Card>
      </CommandPalette>
      <AgentMapDialog open onOpenChange={() => {}}>
        <TranscriptFrame>
          <Card title="记录里">十</Card>
        </TranscriptFrame>
      </AgentMapDialog>
    </Card>
  );
}
