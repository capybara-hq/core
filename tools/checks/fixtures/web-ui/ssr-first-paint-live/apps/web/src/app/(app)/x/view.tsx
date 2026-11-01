"use client";
import { ListPage } from "@capybara-hq/design";
import { useEffect } from "react";
import { subscribeThings } from "@/lib/things";

export default function View() {
  // ssr-exempt: live updates after first paint
  useEffect(() => {
    subscribeThings();
  }, []);
  return <ListPage header={{ path: [], title: "x" }}>x</ListPage>;
}
