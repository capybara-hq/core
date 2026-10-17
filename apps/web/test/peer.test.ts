import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PEER_TOKEN_ENV, PEER_TOKEN_HEADER, trustedPeer } from "../src/lib/peer";

// 包一层真实实现以便断言「用的是常量时间比较」。
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const TOKEN = "s3cr3t-peer-token";

const headers = (token: string | undefined) => {
  const h = new Headers({ "x-forwarded-for": "10.0.0.7" });
  if (token !== undefined) h.set(PEER_TOKEN_HEADER, token);
  return h;
};

describe("trustedPeer（可信标记的比较）", () => {
  afterEach(() => {
    delete process.env[PEER_TOKEN_ENV];
    vi.mocked(crypto.timingSafeEqual).mockClear();
  });

  it("标记一致 → 信任 x-forwarded-for，且用 timingSafeEqual 比较", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    expect(trustedPeer(headers(TOKEN))).toBe("10.0.0.7");
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("等长但不同 → 不信任（经常量时间比较）", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    const forged = `${TOKEN.slice(0, -1)}X`;
    expect(trustedPeer(headers(forged))).toBeUndefined();
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("长度不同 / 多字节字符 / 缺失 → 不信任，不抛错", () => {
    process.env[PEER_TOKEN_ENV] = TOKEN;
    expect(trustedPeer(headers("short"))).toBeUndefined();
    expect(trustedPeer(headers(`${TOKEN}-longer`))).toBeUndefined();
    expect(trustedPeer(headers(undefined))).toBeUndefined();
  });

  it("本进程没有标记（未经 server.mjs）→ 一律不信任", () => {
    expect(trustedPeer(headers(TOKEN))).toBeUndefined();
  });
});
