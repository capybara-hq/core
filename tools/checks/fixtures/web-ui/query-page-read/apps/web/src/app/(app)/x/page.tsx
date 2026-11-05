import { notFound } from "next/navigation";
import { listThings } from "@/lib/things";
import { currentPath } from "@/lib/server/page";
import { read, workspace } from "@/lib/server/page";
import XView from "./view";

export default async function Page() {
  const path = await currentPath();
  const ws = await workspace({});
  const things = await read(listThings());
  if (path === "") notFound();
  return <XView n={things.length + (ws ? 1 : 0)} />;
}