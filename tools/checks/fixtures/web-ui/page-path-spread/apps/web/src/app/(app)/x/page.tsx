import { ListPage } from "@capybara-hq/design";

const base = { path: [] };

export default function Page() {
  return <ListPage header={{ ...base, title: "x" }}>x</ListPage>;
}
