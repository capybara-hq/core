"use client";
import { ListPage } from "@capybara-hq/design";
import { useEffect } from "react";
import { listThings } from "@/lib/things";
import { useLoad } from "@/lib/use-load";

export default function View({ initial }: { initial: string[] }) {
  const bad = useLoad(() => listThings(), []);
  const ok = useLoad(() => listThings(), [], { initial });
  // ssr-exempt: the list depends on the browser
  const exempt = useLoad(() => listThings(), []);
  const empty = useLoad(() => listThings(), []); // ssr-exempt:
  useEffect(() => {
    listThings();
  }, []);
  // ssr-exempt: polls after the first paint
  useEffect(() => {
    listThings();
  }, []);
  return <ListPage header={{ path: [], title: "x" }}>{[bad, ok, exempt, empty]}</ListPage>;
}
