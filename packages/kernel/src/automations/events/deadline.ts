/** A trigger source's `events()` or `visible()` did not settle within its deadline. */
export class TriggerSourceTimeout extends Error {
  constructor(plugin: string, call: string, ms: number) {
    super(`trigger source ${plugin}: ${call} did not answer within ${ms} ms`);
    this.name = "TriggerSourceTimeout";
  }
}

/**
 * `call()` raced against `ms`: a provider whose promise never settles must not hold a maintenance
 * slot (BullMQ renews the job's lock while the process lives) or a request. A synchronous throw
 * of `call` rejects like an asynchronous one.
 */
export async function withDeadline<T>(
  plugin: string,
  what: string,
  ms: number,
  call: () => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TriggerSourceTimeout(plugin, what, ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(call), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
