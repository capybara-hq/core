"use client";
import { ListPage } from "@capybara-hq/design";
import { useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { defineQuery } from "@/lib/query/define";
import { useAppMutation } from "@/lib/query/mutation";
import { keyOf } from "@/lib/query/keys";
import * as things from "@/lib/things";
import { listThings, removeThing, shortName } from "@/lib/things";
import { useLoad } from "@/lib/use-load";
const q = defineQuery({ key: keyOf("x"), fn: () => listThings(), freshness: "mine" });

export default function View() {
  const m = useAppMutation({ fn: (id: string) => removeThing(id), invalidates: () => [] });
  useEffect(() => {
    void listThings();
    void things.refreshThings();
  }, []);
  const load = useLoad(async () => 1, []);
  const onDelete = (id: string) => removeThing(id);
  const name = shortName("abcdefghijk");
  void apiFetch("/api/v1/x");
  return (
    <ListPage header={{ path: [], title: name }}>
      {String(q)}
      {String(m)}
      {String(load)}
      {String(onDelete)}
    </ListPage>
  );
}
