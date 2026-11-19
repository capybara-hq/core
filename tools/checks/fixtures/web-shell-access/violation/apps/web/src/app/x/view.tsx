export function read() {
  const a = window.capybaraShell;
  const b = globalThis.capybaraShell;
  return [a, b];
}
