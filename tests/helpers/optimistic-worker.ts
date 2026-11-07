import { openDatabase } from "../../src/db/index.ts";
import { updateVersionedRow } from "../../src/db/optimistic.ts";

const [dbPath, workId, expectedVersion] = process.argv.slice(2);
if (dbPath === undefined || workId === undefined || expectedVersion === undefined) {
  throw new Error("用法：optimistic-worker.ts <dbPath> <workId> <expectedVersion>");
}

const db = openDatabase({ path: dbPath, migrate: false });
try {
  const result = updateVersionedRow(db, {
    table: "work_items",
    idColumn: "work_id",
    id: workId,
    expectedVersion: Number(expectedVersion),
    values: { title: `updated by ${process.pid}` },
    updatedAtColumn: "updated_at",
    updatedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
