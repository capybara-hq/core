import { Field, ListPage, Segmented, Select, Tabs } from "@capybara-hq/design";
import { useOwnerFilter } from "./filters-scope/owner-filter";

export function Direct() {
  return <ListPage filters={<Segmented label="scope" value="all" options={[]} />} />;
}

export function ThroughConst() {
  const filters = <Tabs label="source" value="all" items={[]} />;
  return <ListPage filters={filters} />;
}

export function ThroughCommon() {
  const filters = (
    <Field label="scope">
      <Segmented label="scope" value="all" options={[]} />
    </Field>
  );
  const common = { variant: "cards" as const, filters };
  return <ListPage {...common} />;
}

export function ConditionalSpread({ many }: { many: boolean }) {
  return (
    <ListPage
      {...(many ? { filters: <Tabs label="source" value="all" items={[]} /> } : {})}
    />
  );
}

function useScope() {
  return { filters: <Segmented label="scope" value="all" options={[]} /> };
}

export function SameFileHook() {
  const scope = useScope();
  return <ListPage filters={scope.filters} />;
}

export function ImportedHook() {
  const owner = useOwnerFilter();
  return <ListPage filters={owner.filters} />;
}

export function Fine() {
  return (
    <ListPage
      filters={
        <Field label="status">
          <Select label="status" value="" options={[]} onChange={() => {}} />
        </Field>
      }
    />
  );
}

export function SegmentedElsewhere() {
  // a Segmented in the page body, not in `filters`
  return (
    <ListPage filters={<Field label="x">x</Field>}>
      <Segmented label="view" value="a" options={[]} />
    </ListPage>
  );
}
