export const opt = (p: { provider: string }, m: { id: string }) => ({
  value: `${p.provider}/${m.id}`,
  label: `${p.provider}/${m.id}`,
});
