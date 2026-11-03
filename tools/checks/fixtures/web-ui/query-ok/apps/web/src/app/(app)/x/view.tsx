"use client";
import { ListPage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { agentsQuery } from "@/lib/query/agents";
import { keys } from "@/lib/query/keys";
import { defineQuery } from "@/lib/query/define";
import { useAppMutation } from "@/lib/query/mutation";
import { removeThing, shortName } from "@/lib/things";

const things = defineQuery({ key: keys.org("o").agents(), fn: () => removeThing("a"), freshness: "mine" });

export default function View({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const a = useQuery({ ...agentsQuery(orgId), enabled: orgId !== "" });
  const m = useAppMutation({
    fn: (id: string) => removeThing(id),
    invalidates: () => [keys.org(orgId).agents()],
  });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.org(orgId).all });
  // query-exempt: the legacy export needs the raw read
  void removeThing("x");
  return (
    <ListPage header={{ path: [], title: shortName("abc") }}>
      {String(a)}
      {String(m)}
      {String(refresh)}
      {String(things)}
    </ListPage>
  );
}
