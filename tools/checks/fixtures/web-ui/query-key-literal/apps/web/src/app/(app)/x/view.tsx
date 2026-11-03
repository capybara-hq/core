"use client";
import { ListPage } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { defineQuery } from "@/lib/query/define";
import { keys } from "@/lib/query/keys";

const q = defineQuery({ key: ["org", "o1", "things"], fn: async () => 1, freshness: "mine" });
const ok = defineQuery({ key: keys.org("o1").agents(), fn: async () => 1, freshness: "mine" });

export default function View() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["org", "o1"] });
  const fine = () => qc.invalidateQueries({ queryKey: keys.org("o1").all });
  return (
    <ListPage header={{ path: [], title: "x" }}>
      {String(q)}
      {String(ok)}
      {String(refresh)}
      {String(fine)}
    </ListPage>
  );
}
