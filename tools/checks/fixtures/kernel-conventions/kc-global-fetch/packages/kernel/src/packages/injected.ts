// A `fetch` the file binds itself (a parameter, a destructured option) or a method named fetch
// is not the global one.
export async function viaParam(fetch: (u: string) => Promise<unknown>, url: string) {
  return fetch(url);
}
export async function viaOption({ fetch }: { fetch: (u: string) => Promise<unknown> }) {
  return fetch("https://example.com");
}
export async function viaMember(source: { fetch(u: string): Promise<unknown> }) {
  return source.fetch("https://example.com");
}
