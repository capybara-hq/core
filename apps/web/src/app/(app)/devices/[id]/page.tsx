import DeviceView from "./view";

/**
 * `/devices/[id]`: one of the person's devices. It reads nothing: the layout prefetches it
 * on a first load (`lib/query/routes.ts`); a missing one is the not-found state in the shell.
 */
export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeviceView id={id} />;
}
