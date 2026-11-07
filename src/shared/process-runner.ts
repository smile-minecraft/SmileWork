/**
 * 以 argv 直啟程序，不經過 shell；輸出有大小上限。
 *
 * 結算點是 leader 的 exit，不是 pipe EOF：背景子程序可能繼承 stdout/stderr
 * 並讓 pipe 一直開著。leader 正常 exit 後只做有界收尾，不對背景程序送訊號；
 * 只有 leader 在 timeout 前沒有 exit 時，才終止整個程序群組。
 */

export interface RunProcessOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** 完整環境變數；省略時使用 buildSafeEnv()。 */
  env?: Record<string, string>;
  /** 省略 env 時，從 process.env 挑選的允許清單；支援尾端 * 前綴。 */
  allowEnv?: readonly string[];
  timeoutMs?: number;
  /** stdout 與 stderr 各自保留的位元組上限；頭端與尾端都保留。 */
  maxOutputBytes?: number;
}

export interface RunProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_*",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
] as const;

const SECRET_LIKE = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

/** leader exit 後等 pipe 收尾的上限；背景程序握著 pipe 時不能無限等。 */
const GROUP_DRAIN_WAIT_MS = 500;
/** timeout 終止後等 leader exit 的上限。 */
const LEADER_EXIT_WAIT_MS = 500;
/** 截斷時保留的頭端與尾端上限。 */
const HEAD_BYTES = 4 * 1024;
const TAIL_BYTES = 16 * 1024;

function allowedBy(rule: string, key: string): boolean {
  if (rule.endsWith("*")) return key.startsWith(rule.slice(0, -1));
  return rule === key;
}

/** 從來源環境挑選允許的鍵，並一律排除看起來像機密的鍵。 */
export function buildSafeEnv(
  source: NodeJS.ProcessEnv = process.env,
  allow: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_LIKE.test(key)) continue;
    if (!allow.some((rule) => allowedBy(rule, key))) continue;
    output[key] = value;
  }
  return output;
}

interface CaptureBudget {
  head: number;
  tail: number;
}

/** 上限夠大時用固定頭 4 KiB／尾 16 KiB；上限較小時按 20%／80% 分配。 */
function captureBudget(maxBytes: number): CaptureBudget {
  const total = Math.max(0, Math.floor(maxBytes));
  if (total === 0) return { head: 0, tail: 0 };
  const head = Math.min(HEAD_BYTES, Math.max(1, Math.floor(total / 5)));
  const tail = Math.min(TAIL_BYTES, Math.max(0, total - head));
  return { head, tail };
}

interface Capture {
  headBudget: number;
  tailBudget: number;
  head: Uint8Array[];
  headBytes: number;
  tail: Uint8Array[];
  tailBytes: number;
  totalBytes: number;
}

function newCapture(maxBytes: number): Capture {
  const budget = captureBudget(maxBytes);
  return {
    headBudget: budget.head,
    tailBudget: budget.tail,
    head: [],
    headBytes: 0,
    tail: [],
    tailBytes: 0,
    totalBytes: 0,
  };
}

function pushCapture(capture: Capture, chunk: Uint8Array): void {
  capture.totalBytes += chunk.byteLength;

  let offset = 0;
  if (capture.headBytes < capture.headBudget) {
    const take = Math.min(capture.headBudget - capture.headBytes, chunk.byteLength);
    if (take > 0) {
      capture.head.push(chunk.subarray(0, take));
      capture.headBytes += take;
      offset = take;
    }
  }

  const rest = chunk.subarray(offset);
  if (rest.byteLength === 0 || capture.tailBudget === 0) return;

  capture.tail.push(rest);
  capture.tailBytes += rest.byteLength;
  let excess = capture.tailBytes - capture.tailBudget;
  while (excess > 0 && capture.tail.length > 0) {
    const first = capture.tail[0]!;
    if (first.byteLength <= excess) {
      capture.tail.shift();
      capture.tailBytes -= first.byteLength;
      excess -= first.byteLength;
      continue;
    }
    capture.tail[0] = first.subarray(excess);
    capture.tailBytes -= excess;
    excess = 0;
  }
}

function retainedBytes(capture: Capture): number {
  return capture.headBytes + capture.tailBytes;
}

function decodeCapture(capture: Capture): string {
  const total = retainedBytes(capture);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of [...capture.head, ...capture.tail]) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

interface CaptureReader {
  done: Promise<void>;
  cancel(): Promise<void>;
}

/** 持續讀到 EOF；取消時安靜結束，不把串流錯誤當成程序失敗。 */
function startCapture(stream: ReadableStream<Uint8Array>, capture: Capture): CaptureReader {
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      if (value) pushCapture(capture, value);
    }
  })().catch(() => {
    // pipe 被取消或讀取失敗時，保留已經收到的輸出。
  });

  return {
    done,
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // 串流已經關閉。
      }
    },
  };
}

/** 有界等待 promise；完成時清掉計時器，避免留著多餘的 timer。 */
async function waitUpTo(promise: Promise<unknown>, waitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 有界等待所有 reader 收尾；逾時就取消讀取端，讓背景程序不再被我們等。 */
async function drainReaders(readers: readonly CaptureReader[], waitMs: number): Promise<void> {
  const all = Promise.all(readers.map((reader) => reader.done));
  if (await waitUpTo(all, waitMs)) return;

  await Promise.all(readers.map((reader) => reader.cancel()));
  await waitUpTo(all, LEADER_EXIT_WAIT_MS);
}

function terminateGroup(pid: number, child: { kill(): void }): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // 沒有獨立程序群組時退回單一程序終止。
    }
  }
  try {
    child.kill();
  } catch {
    // 程序可能已經結束。
  }
}

export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const args = [...(options.args ?? [])];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const env = options.env ?? buildSafeEnv(process.env, options.allowEnv);
  const started = performance.now();

  const child = Bun.spawn([options.command, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });

  const stdoutCapture = newCapture(maxOutputBytes);
  const stderrCapture = newCapture(maxOutputBytes);
  const stdoutReader = startCapture(child.stdout as ReadableStream<Uint8Array>, stdoutCapture);
  const stderrReader = startCapture(child.stderr as ReadableStream<Uint8Array>, stderrCapture);

  let leaderDone = false;
  let leaderExitCode: number | null = null;
  let leaderSignal: string | number | null = null;
  let timedOut = false;
  let exitDurationMs: number | null = null;

  const leaderExited = child.exited.then((code) => {
    leaderDone = true;
    leaderExitCode = code;
    leaderSignal = child.signalCode;
    if (exitDurationMs === null) exitDurationMs = Math.round(performance.now() - started);
    return "exit" as const;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      if (leaderDone) return;
      timedOut = true;
      if (exitDurationMs === null) exitDurationMs = Math.round(performance.now() - started);
      terminateGroup(child.pid, child);
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([leaderExited, timeoutPromise]);
    if (outcome === "exit") {
      clearTimeout(timer);
      await drainReaders([stdoutReader, stderrReader], GROUP_DRAIN_WAIT_MS);
    } else {
      clearTimeout(timer);
      await waitUpTo(leaderExited, LEADER_EXIT_WAIT_MS);
      await drainReaders([stdoutReader, stderrReader], GROUP_DRAIN_WAIT_MS);
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    command: options.command,
    args,
    exitCode: timedOut ? null : leaderExitCode,
    signal: leaderSignal,
    stdout: decodeCapture(stdoutCapture),
    stderr: decodeCapture(stderrCapture),
    timedOut,
    truncated:
      stdoutCapture.totalBytes > retainedBytes(stdoutCapture) ||
      stderrCapture.totalBytes > retainedBytes(stderrCapture),
    durationMs:
      exitDurationMs === null ? Math.round(performance.now() - started) : exitDurationMs,
  };
}
