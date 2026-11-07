import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { openDatabase } from "../../src/db/index.ts";
import { exportCurrent } from "../../src/export/current/index.ts";
import { importPackage } from "../../src/import/index.ts";
import { validatePackage } from "../export-format/helpers/package.ts";
import { writePackage } from "../export-format/helpers/writer.ts";
import type { PackageInput, SignalRecord } from "../export-format/helpers/types.ts";
import { withTempHome } from "../helpers/temp.ts";
import {
  FIXED_CREATED_AT,
  makeTempDir,
  readJsonLines,
  removeDir,
  signalInternalDetails,
  signalUserDetails,
} from "./helpers.ts";

const SIGNALS: SignalRecord[] = [
  {
    signalId: "s-columns",
    severity: "warning",
    code: "MIGRATED_WARNING",
    message: "匯入後要能從欄位讀到",
    details: { legacy: true, source: "fixture" },
  },
  {
    signalId: "s-second",
    severity: "info",
    code: "PROJECT_NOTE",
    message: "第二筆訊號",
  },
];

function signalPackage(root: string, signals: SignalRecord[] = SIGNALS): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "signal-project", layers: ["project"] },
    work: [
      {
        workId: "w-signal",
        kind: "task",
        title: "訊號工作",
        status: "open",
        owner: "build",
        priority: "medium",
      },
    ],
    events: [],
    evidence: [],
    signals,
    knowledge: [],
    mapping: [],
    raw: [],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

interface SignalRow {
  severity: string | null;
  code: string | null;
  details: string | null;
}

function readSignal(db: ReturnType<typeof openDatabase>, signalId: string): SignalRow | null {
  return db
    .query<SignalRow, [string]>("SELECT severity, code, details FROM signals WHERE signal_id = ?")
    .get(signalId);
}

describe("訊號的新欄位", () => {
  test("匯入時 severity、code、details 直接寫進 signals 欄位", async () => {
    const root = makeTempDir("signal-columns");
    const packageDir = join(root, "package");
    try {
      signalPackage(packageDir);
      await withTempHome("signal-columns-home", async (home) => {
        const result = importPackage({ packageDir, home });
        expect(result.inserted.signals).toBe(2);

        const db = openDatabase({ home });
        try {
          const row = readSignal(db, "s-columns");
          expect(row).not.toBeNull();
          expect(row!.severity).toBe("warning");
          expect(row!.code).toBe("MIGRATED_WARNING");
          expect(JSON.parse(row!.details!)).toEqual({ legacy: true, source: "fixture" });
          expect(
            db
              .query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?")
              .get("signal-export:s-columns"),
          ).toBeNull();
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(root);
    }
  });

  test("舊資料只有 metadata 時，匯出仍保留 severity、code、details", async () => {
    const root = makeTempDir("signal-metadata-fallback");
    const packageDir = join(root, "package");
    try {
      signalPackage(packageDir);
      await withTempHome("signal-metadata-fallback-home", async (home, homeRoot) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          db.query(
            "UPDATE signals SET severity = NULL, code = NULL, details = NULL WHERE signal_id = ?",
          ).run("s-columns");
          db.query("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)").run(
            "signal-export:s-columns",
            JSON.stringify({
              legacy: true,
              source: "old",
              smileworkExport: { severity: "error", code: "OLD_FALLBACK" },
            }),
            FIXED_CREATED_AT,
          );
        } finally {
          db.close();
        }

        const result = exportCurrent({
          outDir: join(homeRoot, "export"),
          home,
          createdAt: FIXED_CREATED_AT,
        });
        const validated = validatePackage(result.outDir);
        const signal = validated.signals.find((record) => record.signalId === "s-columns");
        expect(signal?.severity).toBe("error");
        expect(signal?.code).toBe("OLD_FALLBACK");
        expect(signalUserDetails(signal!)).toEqual({
          legacy: true,
          source: "old",
        });
        expect(signalInternalDetails(signal!)?.scope).toBe("project");
      });
    } finally {
      removeDir(root);
    }
  });

  test("欄位與舊 metadata 同時存在時，匯出以欄位為準", async () => {
    const root = makeTempDir("signal-column-priority");
    const packageDir = join(root, "package");
    try {
      signalPackage(packageDir);
      await withTempHome("signal-column-priority-home", async (home, homeRoot) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          db.query("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)").run(
            "signal-export:s-columns",
            JSON.stringify({
              legacy: true,
              source: "metadata",
              smileworkExport: { severity: "error", code: "METADATA_CODE" },
            }),
            FIXED_CREATED_AT,
          );
        } finally {
          db.close();
        }

        const result = exportCurrent({
          outDir: join(homeRoot, "export"),
          home,
          createdAt: FIXED_CREATED_AT,
        });
        const signal = validatePackage(result.outDir).signals.find(
          (record) => record.signalId === "s-columns",
        );
        expect(signal?.severity).toBe("warning");
        expect(signal?.code).toBe("MIGRATED_WARNING");
        expect(signalUserDetails(signal!)).toEqual({
          legacy: true,
          source: "fixture",
        });
        expect(signalInternalDetails(signal!)?.scope).toBe("project");
      });
    } finally {
      removeDir(root);
    }
  });

  test("匯入、匯出、再匯入後 severity、code、details 不丟失", async () => {
    const root = makeTempDir("signal-roundtrip");
    const packageDir = join(root, "package");
    const exportDir = join(root, "export");
    const secondHome = join(root, "second-home", ".smilework");
    try {
      signalPackage(packageDir);
      await withTempHome("signal-roundtrip-home", async (home) => {
        importPackage({ packageDir, home });
        const exported = exportCurrent({
          outDir: exportDir,
          home,
          createdAt: FIXED_CREATED_AT,
        });
        validatePackage(exported.outDir);
        const exportedSignals = readJsonLines(join(exported.outDir, "signals.jsonl"));
        const original = exportedSignals.find((record) => record.signalId === "s-columns");
        expect(original?.severity).toBe("warning");
        expect(original?.code).toBe("MIGRATED_WARNING");
        expect(signalUserDetails(original!)).toEqual({
          legacy: true,
          source: "fixture",
        });
        expect(signalInternalDetails(original!)?.scope).toBe("project");
      });

      importPackage({ packageDir: exportDir, home: secondHome });
      const db = openDatabase({ home: secondHome });
      try {
        const row = readSignal(db, "s-columns");
        expect(row!.severity).toBe("warning");
        expect(row!.code).toBe("MIGRATED_WARNING");
        expect(JSON.parse(row!.details!)).toEqual({ legacy: true, source: "fixture" });
      } finally {
        db.close();
      }
    } finally {
      removeDir(root);
    }
  });

  test("不合法 severity 或過長 code 只記 warning，其他訊號仍匯入", async () => {
    const root = makeTempDir("signal-invalid");
    const packageDir = join(root, "package");
    try {
      signalPackage(packageDir, [
        {
          signalId: "s-bad",
          severity: "critical" as SignalRecord["severity"],
          code: "X".repeat(80),
          message: "不合法的訊號",
          details: { legacy: true },
        },
        {
          signalId: "s-good",
          severity: "info",
          code: "GOOD_SIGNAL",
          message: "合法訊號",
        },
      ]);

      await withTempHome("signal-invalid-home", async (home) => {
        const result = importPackage({ packageDir, home });
        expect(result.inserted.signals).toBe(2);
        expect(
          result.warnings.some((warning) => warning.includes("INVALID_SIGNAL_SEVERITY")),
        ).toBe(true);
        expect(result.warnings.some((warning) => warning.includes("INVALID_SIGNAL_CODE"))).toBe(
          true,
        );

        const db = openDatabase({ home });
        try {
          const bad = readSignal(db, "s-bad");
          expect(bad).not.toBeNull();
          expect(bad!.severity).toBe("info");
          expect(bad!.code).not.toBeNull();
          expect(bad!.code!.length).toBeLessThanOrEqual(64);
          const good = readSignal(db, "s-good");
          expect(good).toEqual({ severity: "info", code: "GOOD_SIGNAL", details: null });
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(root);
    }
  });
});
