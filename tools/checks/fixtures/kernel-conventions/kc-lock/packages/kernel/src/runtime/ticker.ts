// No ioredis import: a plain interval is not a lock renewal timer.
export const tick = (f: () => void) => setInterval(f, 1000);
