import zh from "../../messages/zh.json";

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

/**
 * One line of the bucket, with `{name}` filled. `lines` are the locale's `chat.greeting.<bucket>`
 * messages (a page passes `t.raw(...)`); without them the zh set is used. `random` returns [0, 1).
 */
export function pickGreeting(
  bucket: GreetingBucket,
  name: string,
  random: () => number = Math.random,
  lines: readonly string[] = zh.chat.greeting[bucket],
): string {
  const line = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))] ?? "";
  return line.replaceAll("{name}", name);
}
