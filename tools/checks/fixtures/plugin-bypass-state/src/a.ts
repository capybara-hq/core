const { setTimeout: st } = globalThis;
const r = Reflect.get(globalThis, "setInterval");
const { setImmediate } = globalThis;
export { r, setImmediate, st };
