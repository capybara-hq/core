export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | null | undefined | false): Promise<T> {
  const value = fn();
  if (value === null || value === undefined || value === false) throw new Error("waiting");
  return value;
}

export async function startKernel(): Promise<void> {}
