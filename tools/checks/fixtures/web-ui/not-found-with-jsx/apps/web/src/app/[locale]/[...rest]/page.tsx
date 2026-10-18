import { notFound } from "next/navigation";

export default function CatchAll({ ok }: { ok: boolean }) {
  if (!ok) notFound();
  return <div>hello</div>;
}
