import { type ChannelCard, renderCardAsText } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { adaptToFeatures } from "../../src/channels/features.js";

const bind: ChannelCard = { kind: "bind", url: "https://cap.example/bind/x", text: "Link it" };
const connect: ChannelCard = { kind: "connect", appName: "Docs", url: "https://cap.example/c" };
const target = { chatId: "g1", chatType: "group" as const, threadId: "m1" };
const all = { cards: true, edit: true, threads: true };

describe("adaptToFeatures（Ruling A33）", () => {
  it("支持卡片与话题的渠道原样交给插件", () => {
    const message = { text: "hi", cards: [bind] };
    expect(adaptToFeatures(all, target, message, "en")).toEqual({ target, message });
  });

  it("features.cards = false：卡片按 renderCardAsText 拼进正文（空行分隔），不带 cards", () => {
    const r = adaptToFeatures(
      { ...all, cards: false },
      target,
      { text: "hi", cards: [bind, connect] },
      "zh",
    );
    expect(r.message).toEqual({
      text: `hi\n\n${renderCardAsText(bind, "zh")}\n\n${renderCardAsText(connect, "zh")}`,
    });
    expect(r.target).toEqual(target);
  });

  it("features.cards = false 且正文为空：只有卡片文本；没有卡片时消息不变", () => {
    expect(
      adaptToFeatures({ ...all, cards: false }, target, { text: "", cards: [bind] }, "en").message,
    ).toEqual({ text: renderCardAsText(bind, "en") });
    const plain = { text: "only text" };
    expect(adaptToFeatures({ ...all, cards: false }, target, plain, "en").message).toEqual(plain);
    expect(
      adaptToFeatures({ ...all, cards: false }, target, { text: "x", cards: [] }, "en").message,
    ).toEqual({ text: "x" });
  });

  it("features.threads = false：目标去掉 threadId", () => {
    const r = adaptToFeatures({ ...all, threads: false }, target, { text: "hi" }, "en");
    expect(r.target).toEqual({ chatId: "g1", chatType: "group" });
  });
});
