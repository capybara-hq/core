// The permanent exception (KC_EXCEPTIONS): the operator's own log endpoint.
export async function push(url: string) {
  await fetch(url, { method: "POST" });
}
