import TemplateView from "./view";

/**
 * `/agents/templates/[id]`: one agent template (rulings P4-12, P4-14) by section (`?s=`): the read
 * view for members, the editor for owner-org admins. It reads nothing: the layout prefetches the
 * template and the components offered to the org, and for an owner-org admin the editor's reads,
 * on a first load (`lib/query/routes.ts`); the view reads them from the cache.
 */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const { id } = await params;
  const raw = (await searchParams)?.s;
  const section = Array.isArray(raw) ? raw[0] : raw;
  return <TemplateView id={id} {...(section === undefined ? {} : { section })} />;
}
