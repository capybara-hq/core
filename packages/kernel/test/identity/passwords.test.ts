import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { validatePassword } from "../../src/identity/login.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../../src/identity/passwords.js";

const PW = "correct horse battery";

describe("passwords", () => {
  it("两次哈希不同，格式正确，正确/错误密码校验", async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1\$32768\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword(a, PW)).toBe(true);
    expect(await verifyPassword(a, "wrong horse battery")).toBe(false);
  });
  it("格式被篡改返回 false", async () => {
    const a = await hashPassword(PW);
    expect(await verifyPassword(a.replace("scrypt$1", "scrypt$2"), PW)).toBe(false);
    expect(await verifyPassword("garbage", PW)).toBe(false);
    expect(await verifyPassword(`${a}$extra`, PW)).toBe(false);
    expect(await verifyPassword(a.replace("$32768$", "$abc$"), PW)).toBe(false);
    expect(await verifyPassword(a.replace("$32768$", "$1073741824$"), PW)).toBe(false);
  });
  it("DUMMY_PASSWORD_HASH 可校验且不匹配", async () => {
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, "whatever-password")).toBe(false);
  });
  it("validatePassword 边界", () => {
    expect(() => validatePassword("short")).toThrow(ApiError);
    expect(() => validatePassword("a".repeat(257))).toThrow(ApiError);
  });
});
