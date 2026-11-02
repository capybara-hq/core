"use client";

import { ListPage } from "@capybara-hq/design";

export const PAGE_SIZE = 20;
export type Data = { n: number };

export default function XView({ initial }: { initial: Data }) {
  return <ListPage header={{ path: [], title: String(initial.n + PAGE_SIZE) }}>x</ListPage>;
}
