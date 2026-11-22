"use client";
import { ListPage, Segmented } from "@capybara-hq/design";

export default function AgentsView() {
  const filters = <Segmented label="f" value="all" onChange={() => {}} options={[]} />;
  return <ListPage variant="cards" listLabel="agents" filters={filters} />;
}
