import { parseSkillAddress } from "../../../../lib/skills";
import SkillView from "./view";

/**
 * `/skills/[id]`: an org skill (members up), the tab in `?tab=` and the Files tab's file and version
 * in `?file=` / `?version=`. It reads nothing: the layout prefetches the skill (and the files the
 * address opens) on a first load (`lib/query/routes.ts`); a missing one is the not-found state in
 * the shell.
 */
export default async function SkillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const q = (await searchParams) ?? {};
  const at = parseSkillAddress((n) => {
    const v = q[n];
    return Array.isArray(v) ? v[0] : v;
  });
  return <SkillView skillId={id} initial={at} />;
}
