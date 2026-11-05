/** The time-of-day sets of greeting lines (`chat.greeting.<bucket>` in the messages). */
export type GreetingBucket = "morning" | "noon" | "afternoon" | "evening" | "night";

/** The bucket of a local hour (0-23): 5-10 morning, 11-12 noon, 13-17 afternoon, 18-22 evening, else night. */
export function greetingBucket(hour: number): GreetingBucket {
  if (hour >= 5 && hour <= 10) return "morning";
  if (hour >= 11 && hour <= 12) return "noon";
  if (hour >= 13 && hour <= 17) return "afternoon";
  if (hour >= 18 && hour <= 22) return "evening";
  return "night";
}

/** The locale's `chat.greeting` messages by bucket (`t.raw("greeting")` in a page; `sub` is ignored). */
export type GreetingLines = Readonly<Record<GreetingBucket, readonly string[]>>;

/**
 * One line of the bucket's `lines` with `{name}` filled. `random` returns [0, 1).
 */
export function pickGreeting(
  bucket: GreetingBucket,
  name: string,
  lines: GreetingLines,
  random: () => number = Math.random,
): string {
  const set = lines[bucket];
  const line = set[Math.min(set.length - 1, Math.floor(random() * set.length))] ?? "";
  return line.replaceAll("{name}", name);
}
