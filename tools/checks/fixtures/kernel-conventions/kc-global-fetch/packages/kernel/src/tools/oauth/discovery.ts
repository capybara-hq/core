export async function oauthFetch(url: string) {
  const res = await fetch(url, { redirect: "manual" }); // expect: kc-global-fetch
  const again = await globalThis.fetch(url); // expect: kc-global-fetch
  return [res, again];
}
