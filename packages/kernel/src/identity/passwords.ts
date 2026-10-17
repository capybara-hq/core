import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 哈希密码，格式 `scrypt$1$N$r$p$<salt b64>$<hash b64>`。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(plain, salt);
  return `scrypt$1$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** 校验密码；格式不认识（含参数不符）一律返回 false，不抛错。 */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "1") return false;
  if (parts[2] !== String(N) || parts[3] !== String(R) || parts[4] !== String(P)) return false;
  const salt = Buffer.from(parts[5] ?? "", "base64");
  const expected = Buffer.from(parts[6] ?? "", "base64");
  if (salt.length === 0 || expected.length !== KEYLEN) return false;
  try {
    return timingSafeEqual(await derive(plain, salt), expected);
  } catch {
    return false;
  }
}

/** 账号不存在时也跑一次校验，防止按耗时枚举登录名。 */
export const DUMMY_PASSWORD_HASH = `scrypt$1$${N}$${R}$${P}$${Buffer.alloc(16, 1).toString("base64")}$${Buffer.alloc(KEYLEN, 2).toString("base64")}`;
