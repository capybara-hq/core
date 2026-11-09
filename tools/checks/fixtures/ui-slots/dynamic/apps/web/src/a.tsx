export const A = ({ id }: { id: string }) => (
  <>
    <ExtensionSlot slot="x.one" args={{}} />
    <ExtensionSlot slot={id} args={{}} />
  </>
);
