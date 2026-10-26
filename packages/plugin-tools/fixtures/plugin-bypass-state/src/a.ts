const { setTimeout: st } = globalThis;
const r = Reflect.get(globalThis, "setInterval");
const { setImmediate } = globalThis;
const si = globalThis["set" + "Immediate"];
const sto = Reflect.get(globalThis, "set" + "Time" + `out`);
const ok = "set" + "Value";
export { ok, r, setImmediate, si, st, sto };
