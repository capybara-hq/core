import SkillView from "./view";

/**
 * `/skills/[id]`: an org skill (members up). It reads nothing: the layout prefetches the skill on a
 * first load (`lib/query/routes.ts`); a missing one is the not-found state in the shell.
 */
export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillView skillId={id} />;
}
