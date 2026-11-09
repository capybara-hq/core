import { describe, expect, it } from "vitest";
import {
  findTokenLikeSpans,
  removeSpans,
  shannonEntropy,
  type TokenLikeKind,
} from "../src/conversation/token-like";

// Setup guides v2 spec §12.1: the composer's token paste warning. Synthetic samples only: every
// "token" below is made up and matches the shape, never a real credential.

const kinds = (text: string) => findTokenLikeSpans(text).map((s) => s.kind);
const ALNUM = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2dE3fG4hJ5kL6";
const alnum = (n: number) => ALNUM.repeat(3).slice(0, n);
/** A 40-character base64url string drawn from a fixed seed (high entropy, digits and letters). */
const RANDOM_40 = "Zq3vN8pL0xW2kR7tY5uB1mC9dF4gH6jS_aE-oIzQ";

describe("findTokenLikeSpans matches", () => {
  const cases: [string, string, TokenLikeKind][] = [
    ["Slack bot token", "xoxb-123456789012-abcdefghij", "slack-token"],
    ["Slack user token", "xoxp-123456789012-123456789012-abcdef", "slack-token"],
    ["Slack app token", "xapp-1-A0123456789-abcdef", "slack-app-token"],
    ["GitHub classic token", `ghp_${alnum(36)}`, "github-token"],
    ["GitHub server token", `ghs_${alnum(36)}`, "github-token"],
    ["GitHub fine-grained token", `github_pat_${alnum(22)}`, "github-token"],
    ["Anthropic key", `sk-ant-api03-${alnum(30)}`, "api-key"],
    ["OpenAI project key", `sk-proj-${alnum(40)}`, "api-key"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE", "aws-key"],
    ["Google API key", `AIza${alnum(35)}`, "google-key"],
    ["PEM header", "-----BEGIN RSA PRIVATE KEY-----", "private-key"],
    ["OpenSSH header", "-----BEGIN OPENSSH PRIVATE KEY-----", "private-key"],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "jwt",
    ],
    ["random base64url", RANDOM_40, "high-entropy"],
  ];
  for (const [name, sample, kind] of cases) {
    it(`${name} alone`, () => {
      expect(findTokenLikeSpans(sample)).toEqual([{ start: 0, end: sample.length, kind }]);
    });
    it(`${name} inside a sentence`, () => {
      const text = `my token is ${sample}, please use it`;
      const spans = findTokenLikeSpans(text);
      expect(spans).toEqual([{ start: 12, end: 12 + sample.length, kind }]);
    });
  }

  it("a whole PEM block is one span", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const text = `here:\n${pem}\nthanks`;
    expect(findTokenLikeSpans(text)).toEqual([
      { start: 6, end: 6 + pem.length, kind: "private-key" },
    ]);
  });

  it("a token quoted alone in an inline code span still matches", () => {
    expect(kinds(`use \`${RANDOM_40}\``)).toEqual(["high-entropy"]);
  });

  it("vendor patterns match inside code with words", () => {
    expect(kinds('```\nconst token = "xoxb-123456789012-abcdefghij";\n```')).toEqual([
      "slack-token",
    ]);
  });

  it("several tokens come back in order", () => {
    const text = `bot xoxb-123456789012-abcdefghij app xapp-1-A0123456789-abcdef`;
    expect(kinds(text)).toEqual(["slack-token", "slack-app-token"]);
  });

  it("an env line with a token", () => {
    expect(kinds(`SLACK_BOT_TOKEN=xoxb-123456789012-abcdefghij`)).toEqual(["slack-token"]);
  });
});

describe("findTokenLikeSpans non-matches", () => {
  const cases: [string, string][] = [
    ["a UUID", "3f2a9c1e-7b4d-4e8f-9a6b-2c5d8e1f0a3b"],
    ["an id around a UUID", "conv_3f2a9c1e-7b4d-4e8f-9a6b-2c5d8e1f0a3b"],
    ["a 40-hex commit hash", "e8008def3c1b9a7f5e4d2c0b8a6f4e2d0c9b7a5f"],
    ["a 64-hex sha256", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["a long URL", "https://example.com/a/very/long/path/with/many/segments/0123456789"],
    ["a URL with a random query", `https://example.com/callback?state=${RANDOM_40}&code=1`],
    [
      "a prose sentence",
      "Please help me finish setting up the Slack channel for the support team today.",
    ],
    ["Chinese prose", "请帮我完成 Slack 渠道的接入，机器人令牌我已经填在设置页里了，谢谢。"],
    [
      "a code block with words",
      `\`\`\`ts\nconst value = "${RANDOM_40}";\nexport default value;\n\`\`\``,
    ],
    ["an inline code span with words", `run \`curl -H "X-Id: ${RANDOM_40}" localhost\` first`],
    [
      "a data URI",
      `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`,
    ],
    ["a file path", "packages/design/src/conversation/composer2/token-like-test.ts"],
    ["a snake_case identifier", "find_token_like_spans_matches_every_pattern_2"],
    ["a kebab-case slug", "setup-guides-v2-kernel-capybara-checks-and-the-probe"],
    ["a camelCase test name", "findTokenLikeSpansMatchesEveryVendorPattern2"],
    [
      "an SRI hash",
      "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    ],
    ["a long number", "1234567890123456789012345678901234567890"],
    ["a long kebab word after sk-", "sk-something-long-and-friendly-words"],
    ["task- is not sk-", "task-runner-for-the-nightly-build-0123"],
    ["a markdown rule", "----------------------------------------"],
    ["a short Slack-like word", "xoxb-short"],
    ["an env line", "CAPYBARA_EXTENSION_CONFIG__EXAMPLE_COUNTER__POOL_SIZE=3"],
    ["a package path", "capybara-hq/plugin-object-store-s3"],
    ["a package with a platform", "oxc-parser/binding-linux-s390x-gnu"],
    ["a dated doc name", "2026-10-25-ecosystem-phase0b-formats"],
    ["an alphabet in code", "abcdefghijklmnopqrstuvwxyz0123456789"],
    [
      "raw base64 of a PNG",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ],
    ["empty", ""],
  ];
  for (const [name, sample] of cases) {
    it(name, () => {
      expect(findTokenLikeSpans(sample)).toEqual([]);
    });
  }
});

describe("removeSpans", () => {
  it("deletes the matched spans and keeps the rest", () => {
    const text = "bot xoxb-123456789012-abcdefghij and app xapp-1-A0123456789-abcdef done";
    expect(removeSpans(text, findTokenLikeSpans(text))).toBe("bot  and app  done");
  });
});

describe("shannonEntropy", () => {
  it("is 0 for one repeated character and log2(n) for n distinct ones", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
    expect(shannonEntropy(RANDOM_40)).toBeGreaterThan(4);
  });
});
