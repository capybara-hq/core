import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { type GreetingBucket, greetingBucket, pickGreeting } from "../src/lib/greeting";

const BUCKETS: GreetingBucket[] = ["morning", "noon", "afternoon", "evening", "night"];

describe("greeting", () => {
  it("greetingBucket bounds", () => {
    const at = (h: number) => greetingBucket(h);
    expect([
      at(4),
      at(5),
      at(10),
      at(11),
      at(12),
      at(13),
      at(17),
      at(18),
      at(22),
      at(23),
      at(0),
    ]).toEqual([
      "night",
      "morning",
      "morning",
      "noon",
      "noon",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
      "night",
      "night",
    ]);
    // every hour of the day lands in some bucket
    for (let h = 0; h < 24; h++) expect(BUCKETS).toContain(greetingBucket(h));
  });

  it("pickGreeting fills {name} and stays in the bucket", () => {
    for (const bucket of BUCKETS) {
      const lines = zh.chat.greeting[bucket];
      for (let i = 0; i < lines.length; i++) {
        const random = () => (i + 0.5) / lines.length;
        expect(pickGreeting(bucket, "Grant", zh.chat.greeting, random)).toBe(
          (lines[i] as string).replace("{name}", "Grant"),
        );
      }
      // the largest random value still picks the last line
      expect(pickGreeting(bucket, "Ada", zh.chat.greeting, () => 0.999999)).toBe(
        (lines[lines.length - 1] as string).replace("{name}", "Ada"),
      );
    }
    expect(pickGreeting("evening", "Ada", zh.chat.greeting, () => 0)).toBe("晚上好，Ada");
    // the lines of another locale are passed in the same way
    expect(pickGreeting("night", "Ada", en.chat.greeting, () => 0)).toBe(en.chat.greeting.night[0]);
  });

  it("the greeting copy has the same shape in zh and en", () => {
    for (const b of BUCKETS) {
      expect(en.chat.greeting[b].length).toBe(zh.chat.greeting[b].length);
      expect(en.chat.greeting[b].some((l) => l.includes("{name}"))).toBe(
        zh.chat.greeting[b].some((l) => l.includes("{name}")),
      );
    }
    expect(zh.chat.greeting.sub).toBe("选一个 agent，或从常用任务开始");
    expect(en.chat.greeting.sub).toBe("Pick an agent, or start from a common task");
  });
});
