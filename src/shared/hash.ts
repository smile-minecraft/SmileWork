import { createHash, randomUUID } from "node:crypto";

/** 產生帶前綴的識別碼；前綴只描述種類，不帶流程編號。 */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 專案識別碼：正規化 common dir 的 sha256 前 16 碼。 */
export function projectIdFromCommonDir(commonDir: string): string {
  return sha256Hex(commonDir).slice(0, 16);
}

/** 非 git 專案的路徑識別碼；加前綴避免和 git common dir 的雜湊撞在一起。 */
export function projectIdFromPath(path: string): string {
  return sha256Hex(`path:${path}`).slice(0, 16);
}
