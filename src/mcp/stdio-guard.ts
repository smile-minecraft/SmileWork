import { format, inspect, type InspectOptions } from "node:util";

export interface StdioStdoutGuard {
  restore(): void;
}

type RedirectedMethod = "log" | "info" | "debug" | "warn" | "dir" | "trace";

const REDIRECTED_METHODS: readonly RedirectedMethod[] = [
  "log",
  "info",
  "debug",
  "warn",
  "dir",
  "trace",
];

type ConsoleWriter = (...args: unknown[]) => void;

function writeStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr 可能已經關閉；記錄動作不能中斷 stdio 協定。
  }
}

/**
 * 把會寫到 stdout 的 console 方法改寫到 stderr，直到 restore() 被呼叫。
 * process.stdout 本身保持原狀，serveStdio 才能繼續寫 JSON-RPC frame。
 */
export function installStdioStdoutGuard(): StdioStdoutGuard {
  const target = console as unknown as Record<RedirectedMethod, ConsoleWriter>;
  const originals = {} as Record<RedirectedMethod, ConsoleWriter>;
  const replacements = {} as Record<RedirectedMethod, ConsoleWriter>;

  for (const method of REDIRECTED_METHODS) {
    const original = target[method];
    originals[method] = original;

    const replacement: ConsoleWriter = (...args: unknown[]): void => {
      if (method === "dir") {
        const options = args[1];
        const inspectOptions =
          options !== null && typeof options === "object"
            ? (options as InspectOptions)
            : undefined;
        writeStderr(inspect(args[0], inspectOptions));
        return;
      }
      const line = format(...args);
      if (method === "trace") {
        const stack = new Error().stack?.split("\n").slice(1).join("\n") ?? "";
        writeStderr(stack === "" ? line : `${line}\n${stack}`);
        return;
      }
      writeStderr(line);
    };

    replacements[method] = replacement;
    target[method] = replacement;
  }

  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      for (const method of REDIRECTED_METHODS) {
        if (target[method] === replacements[method]) {
          target[method] = originals[method];
        }
      }
    },
  };
}
