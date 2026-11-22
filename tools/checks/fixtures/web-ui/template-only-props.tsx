import { ListPage, PageHeader, Tabs } from "@capybara-hq/design";

export function Direct() {
  return <PageHeader title="x" primaryForm="inline" />;
}

export function InHeaderObject() {
  return <ListPage header={{ title: "x", primaryForm: "menu" }} />;
}

export function ThroughConst() {
  const header = { title: "x", primaryForm: "inline" };
  return <ListPage header={header} />;
}

export function LookOnTabs() {
  return <Tabs label="x" value="a" items={[]} look="chips" />;
}

export function Fine() {
  // `look` on something else and a header without the prop
  return (
    <ListPage header={{ title: "x" }}>
      <Tabs label="x" value="a" items={[]} />
      <PageHeader title="y" />
    </ListPage>
  );
}

export function TwoOnOneLine() {
  return <PageHeader title="x" primaryForm="a" header={{ primaryForm: "b" }} />;
}
