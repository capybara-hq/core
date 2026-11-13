export async function send(getQueue: (name: string) => { add(n: string, d: unknown): Promise<void> }) {
  await getQueue("x").add("x", {});
}
