// Browser-only: module state here is per document, like timers.
let frames = 0;
const seen = new Set<string>();
export const glitch = () => window.setInterval(() => seen.add(String(frames++)), 80);
