import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

// --- a self-signed certificate (P-256, DER built by hand: no openssl, no extra dependency) ---

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utcTime = (d: Date) =>
  tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));

/** A self-signed CA:TRUE certificate for `dns` names and IPv4 `ips`, PEM, with its key. */
export function selfSigned(dns: string[], ips: string[]): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(dns[0] ?? "test")))));
  const serial = randomBytes(8);
  // positive (top bit clear) and minimal (byte 0 non-zero): a DER INTEGER with a leading zero
  // byte followed by a byte < 0x80 is rejected by OpenSSL ("illegal padding")
  serial[0] = ((serial[0] as number) & 0x7f) | 0x40;
  const san = seq(
    ...dns.map((d) => tlv(0x82, Buffer.from(d))),
    ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  );
  const extensions = tlv(
    0xa3,
    seq(
      seq(
        oid("2.5.29.19"),
        tlv(0x01, Buffer.from([0xff])),
        tlv(0x04, seq(tlv(0x01, Buffer.from([0xff])))),
      ),
      seq(oid("2.5.29.17"), tlv(0x04, san)),
    ),
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
