"use client";
import { ListPage } from "@capybara-hq/design";
import { useCallback, useEffect, useLayoutEffect } from "react";
import { subscribeThings } from "@/lib/things";

export default function View() {
  const reload = useCallback(() => subscribeThings(), []);
  async function refresh() {
    await subscribeThings();
  }
  useEffect(() => {
    reload();
  }, [reload]);
  useLayoutEffect(() => {
    void refresh();
  }, []);
  return <ListPage header={{ path: [], title: "x" }}>x</ListPage>;
}
