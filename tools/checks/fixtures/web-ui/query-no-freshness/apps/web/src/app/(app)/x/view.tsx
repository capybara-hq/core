"use client";
import { ListPage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { agentsQuery } from "@/lib/query/agents";

export default function View() {
  const a = useQuery({ queryKey: keys.org("o1").agents(), queryFn: async () => 1 });
  const b = useQuery({ ...agentsQuery("o1"), enabled: true });
  return (
    <ListPage header={{ path: [], title: "x" }}>
      {String(a)}
      {String(b)}
    </ListPage>
  );
}
