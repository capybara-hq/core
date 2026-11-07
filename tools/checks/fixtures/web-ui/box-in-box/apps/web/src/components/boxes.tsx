import {
  Card,
  CodeBlock,
  DataTable,
  Dialog,
  FilePicker,
  FormSection,
  ItemList,
  ItemListItem,
  RadioGroup,
  RightPanel,
  Sheet,
  Subsection,
} from "@capybara-hq/design";
import type { ReactNode } from "react";
import { ReNotice } from ".";
import { Notice } from "./notice";

function PurposeCard() {
  return <Card title="eval">一</Card>;
}

function Frame({ children }: { children?: ReactNode }) {
  return <Card title="外框">{children}</Card>;
}

function Table() {
  return <DataTable label="表" columns={[]} rows={[]} rowKey={() => ""} />;
}

export function Bad() {
  return (
    <>
      <FormSection id="a" title="用途">
        <Card title="eval">一</Card>
      </FormSection>
      <Card title="外">
        <PurposeCard />
      </Card>
      <Sheet open onOpenChange={() => {}} title="侧板">
        <Notice />
      </Sheet>
      <FormSection id="b" title="供应商">
        <DataTable label="表" columns={[]} rows={[]} rowKey={() => ""} />
        <Table />
      </FormSection>
      <Card>
        <CodeBlock text="x" framed />
      </Card>
      <Card>
        <FilePicker dropLabel="拖到这里" onFiles={() => {}} />
      </Card>
      <Frame>
        <ReNotice />
      </Frame>
      <Card title="列表" actions={<Card>标题里的卡片</Card>} />
    </>
  );
}

export function Good() {
  return (
    <>
      <FormSection id="c" title="用途" flush>
        <ItemList label="用途" inset="flush">
          <ItemListItem title="eval" code="eval" />
        </ItemList>
      </FormSection>
      <FormSection id="d" title="供应商" flush>
        <Subsection title="deepseek" variant="flush">
          <DataTable label="表" columns={[]} rows={[]} rowKey={() => ""} />
        </Subsection>
      </FormSection>
      <Card>
        <CodeBlock text="x" />
        <RadioGroup label="来源" variant="card" value="a" onChange={() => {}} options={[]} />
        <Dialog open onOpenChange={() => {}} title="上传" footer={null}>
          <FilePicker dropLabel="拖到这里" onFiles={() => {}} />
        </Dialog>
      </Card>
      <Sheet open onOpenChange={() => {}} title="面板">
        <RightPanel title="看板" onClose={() => {}}>
          <Card>窗格里的卡片</Card>
        </RightPanel>
      </Sheet>
      <PurposeCard />
    </>
  );
}
