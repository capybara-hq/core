"use client";
import { ListPage } from "@capybara-hq/design";

export default function View({ n }: { n: number }) {
  return <ListPage header={{ path: [], title: "x" }}>{n}</ListPage>;
}
