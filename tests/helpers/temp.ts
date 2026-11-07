import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 建立唯一暫存目錄，結束後一定刪除。 */
export async function withTempDir<T>(prefix: string, run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `smilework-${prefix}-`));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 建立唯一的暫存 SMILEWORK_HOME 給單一測試使用。 */
export async function withTempHome<T>(
  prefix: string,
  run: (home: string, root: string) => T | Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (root) => {
    const home = join(root, "home", ".smilework");
    return await run(home, root);
  });
}
