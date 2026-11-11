/**
 * Public suffixes of more than one label that a device-page wildcard may not cover (a small
 * built-in list, not the public suffix list; the kernel keeps the same list in
 * packages/kernel/src/devices/public-suffix.ts). Includes the shared hosting suffixes where each
 * subdomain belongs to someone else.
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
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
]);

/**
 * Why a `*.` wildcard is too broad to add from the device page: its remainder is a whole public
 * suffix (one label such as `com`, or a known multi-label one such as `co.uk`, `github.io`);
 * null for an exact host or a narrower wildcard.
 */
export function publicSuffixWildcard(pattern: string): string | null {
  if (!pattern.startsWith("*.")) return null;
  const rest = pattern.slice(2).toLowerCase();
  if (!rest.includes(".") || MULTI_LABEL_SUFFIXES.has(rest)) {
    return `Use a narrower domain; ${pattern.toLowerCase()} covers a whole public suffix.`;
  }
  return null;
}
