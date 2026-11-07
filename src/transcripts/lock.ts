import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 15 * 60_000;

interface LockRecord {
  token: string;
  pid: number;
  startedAt: number;
}

export interface BuildLock {
  readonly path: string;
  readonly token: string;
  /** 長工作期間更新 mtime，避免被其他程序誤判成殘留鎖。 */
  touch(): void;
  release(): void;
}

export interface BuildLockOptions {
  readonly pid?: number;
  readonly staleMs?: number;
}

function readRecord(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.token !== "string" ||
      typeof record.pid !== "number" ||
      typeof record.startedAt !== "number"
    ) {
      return null;
    }
    return { token: record.token, pid: record.pid, startedAt: record.startedAt };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function staleAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isUsableLock(path: string, options: BuildLockOptions): boolean {
  try {
    statSync(path);
  } catch {
    return false;
  }
  const record = readRecord(path);
  if (!record) {
    // 檔案存在但內容壞掉：太舊就當成殘留，否則保守地視為仍在使用。
    return staleAge(path) < (options.staleMs ?? DEFAULT_STALE_MS);
  }
  if (!processAlive(record.pid)) return false;
  return staleAge(path) < (options.staleMs ?? DEFAULT_STALE_MS);
}

/** 只讀檢查，不建立任何檔案。 */
export function isBuildLockActive(path: string, options: BuildLockOptions = {}): boolean {
  try {
    return isUsableLock(path, options);
  } catch {
    return false;
  }
}

/**
 * 用 O_EXCL 建立鎖檔，確保多個程序只有一個能開始建索引。
 * 鎖檔會記錄 pid 與 token，釋放時只刪自己的鎖，避免誤刪別人的。
 */
export function acquireBuildLock(path: string, options: BuildLockOptions = {}): BuildLock | null {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const pid = options.pid ?? process.pid;
  const record: LockRecord = { token, pid, startedAt: Date.now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      return {
        path,
        token,
        touch(): void {
          try {
            const now = new Date();
            utimesSync(path, now, now);
          } catch {
            // 鎖檔已消失時不需要補救；真正的釋放會再確認 token。
          }
        },
        release(): void {
          const current = readRecord(path);
          if (current?.token !== token) return;
          try {
            unlinkSync(path);
          } catch {
            // 已經被其他程序清掉，代表沒有殘留。
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isUsableLock(path, options)) return null;
      try {
        unlinkSync(path);
      } catch {
        // 其他程序先清掉了，下一輪再嘗試建立。
      }
    }
  }
  return null;
}

export function buildLockPath(databasePath: string): string {
  return `${databasePath}.build.lock`;
}
