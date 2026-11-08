/**
 * The file-operation helper the OS executor runs **inside the sandbox** (`node -e`), so a
 * kernel-side read or write in the workspace or tmp root never touches the host file system with
 * the program's own privileges: a parent directory swapped for a symlink mid-operation reaches
 * only what any sandboxed command could reach anyway.
 *
 * argv: `<op> <path> <maxBytes> <root>...` with op `read` | `stat` | `write` (data on stdin).
 * stdout: one JSON object, `{ "r": <result> }` or `{ "e": "policy" | "error", "m": <message> }`.
 * read → `null` | `{ b64, truncated }`; stat → `null` | `{ size, isDir }`; write → `null`.
 * Non-regular files (FIFOs, sockets, devices) are refused without blocking (`O_NONBLOCK`).
 */
export const FS_HELPER_SCRIPT = `
(() => {
  const fs = require("fs");
  const path = require("path");
  const C = fs.constants;
  const [op, p, maxS, ...roots] = process.argv.slice(1);
  const out = (o) => process.stdout.write(JSON.stringify(o));
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  const under = (r) => realRoots.some((x) => r === x || r.startsWith(x + "/"));
  const missing = (e) => e && (e.code === "ENOENT" || e.code === "ENOTDIR");
  const real = (q) => { try { return fs.realpathSync(q); } catch (e) { if (missing(e)) return null; throw e; } };
  const outside = (r) => out({ e: "policy", m: p + " resolves to " + r + ", outside the environment's roots" });
  try {
    if (op === "read" || op === "stat") {
      const r = real(p);
      if (r === null) return out({ r: null });
      if (!under(r)) return outside(r);
      const fd = fs.openSync(r, C.O_RDONLY | C.O_NONBLOCK | C.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (op === "stat") return out({ r: { size: st.size, isDir: st.isDirectory() } });
        if (st.isDirectory()) return out({ r: null });
        if (!st.isFile()) return out({ e: "policy", m: p + " is not a regular file" });
        const max = Number(maxS);
        const want = Math.min(st.size, max);
        const buf = Buffer.alloc(want);
        let off = 0;
        while (off < want) {
          const n = fs.readSync(fd, buf, off, want - off, off);
          if (n === 0) break;
          off += n;
        }
        return out({ r: { b64: buf.subarray(0, off).toString("base64"), truncated: st.size > max } });
      } finally {
        fs.closeSync(fd);
      }
    }
    if (op === "write") {
      const data = fs.readFileSync(0);
      const parent = path.dirname(p);
      let anc = parent;
      while (real(anc) === null && anc !== path.dirname(anc)) anc = path.dirname(anc);
      const ra = real(anc);
      if (ra === null || !under(ra)) return outside(ra);
      fs.mkdirSync(parent, { recursive: true });
      const rp = real(parent);
      if (rp === null) return out({ e: "error", m: "cannot create " + parent });
      if (!under(rp)) return outside(rp);
      let file = path.join(rp, path.basename(p));
      let st = null;
      try { st = fs.lstatSync(file); } catch (e) { if (!missing(e)) throw e; }
      if (st && st.isSymbolicLink()) {
        const r = real(file);
        if (r === null) return out({ e: "policy", m: p + " is a dangling symbolic link" });
        if (!under(r)) return outside(r);
        file = r;
      }
      const fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_NONBLOCK | C.O_NOFOLLOW, 0o644);
      try {
        if (!fs.fstatSync(fd).isFile()) return out({ e: "policy", m: p + " is not a regular file" });
        fs.ftruncateSync(fd, 0);
        let off = 0;
        while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off, off);
      } finally {
        fs.closeSync(fd);
      }
      return out({ r: null });
    }
    out({ e: "error", m: "unknown helper op " + op });
  } catch (e) {
    out({ e: "error", m: String((e && e.message) || e) });
  }
})();
`;
