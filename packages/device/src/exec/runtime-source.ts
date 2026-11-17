import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_RUNTIME_SOURCE } from "@capybara-hq/plugin-sdk";
/** Stage only bundled, hash-checked bytes in the owner's private state directory. */
export async function stagePrivateSource(
  stateDir: string,
  name: string,
  source: string,
): Promise<string> {
  const base = await realpath(stateDir);
  const info = await lstat(stateDir);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Runtime state directory must be private and owner controlled");
  const dir = join(base, "operation-runtime");
  await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== info.uid)
    throw new Error("Unsafe runtime staging directory");
  const hash = createHash("sha256").update(source).digest("hex");
  const path = join(dir, `${hash}-${name}`);
  let file: FileHandle | undefined;
  try {
    file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(source);
    await file.sync();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    await file?.close();
  }
  const checked = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await checked.stat();
    if (
      !s.isFile() ||
      s.uid !== info.uid ||
      (s.mode & 0o077) !== 0 ||
      createHash("sha256")
        .update(await checked.readFile())
        .digest("hex") !== hash
    )
      throw new Error("Runtime source identity mismatch");
  } finally {
    await checked.close();
  }
  return path;
}
export async function stageRuntimeSource(stateDir: string): Promise<string> {
  // Bundle 2 added the Linux launcher next to the native helper; this device stages only the helper.
  if (SANDBOX_RUNTIME_SOURCE.version !== 2) throw new Error("Unsupported runtime bundle");
  const file = SANDBOX_RUNTIME_SOURCE.files.find((f) => f.name === "native-files.py");
  if (!file || createHash("sha256").update(file.source).digest("hex") !== file.sha256)
    throw new Error("Runtime source hash mismatch");
  return stagePrivateSource(stateDir, file.name, file.source);
}
