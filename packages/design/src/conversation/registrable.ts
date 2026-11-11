/**
 * Public suffixes of more than one label that the network ask card knows (a small built-in list,
 * not the public suffix list): under these the registrable domain keeps three labels.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "ac.uk",
  "co.uk",
  "gov.uk",
  "ltd.uk",
  "me.uk",
  "net.uk",
  "org.uk",
  "plc.uk",
  "com.cn",
  "edu.cn",
  "gov.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "org.hk",
  "com.tw",
  "org.tw",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "org.nz",
  "com.br",
  "com.mx",
  "com.sg",
  "com.my",
  "co.in",
  "co.za",
  "com.tr",
  "com.ar",
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The registrable domain of a host as the network ask card shows it prominently (spec §6.4,
 * lookalikes): **evil.io** in `files.slack.com.evil.io`. The last two labels, three under a known
 * multi-label suffix (`co.uk`, `com.cn`, …); an IP literal or a single-label name is returned as it
 * is. A display aid for the person reading the card, never a security decision: what is allowed is
 * always the full host.
 */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "" || h.includes(":") || h.startsWith("[") || IPV4.test(h)) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}
