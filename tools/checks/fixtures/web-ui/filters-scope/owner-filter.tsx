import { Tabs } from "@capybara-hq/design";

export function useOwnerFilter() {
  return { filters: <Tabs label="owner" value="all" items={[]} /> };
}
