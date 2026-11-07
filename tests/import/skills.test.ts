import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
import { writePackage } from "../export-format/helpers/writer.ts";
import type { PackageInput } from "../export-format/helpers/types.ts";
import { withTempHome } from "../helpers/temp.ts";
import { FIXED_CREATED_AT, makeTempDir, removeDir, scanHashes } from "./helpers.ts";

function skillPackage(root: string): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "skill-project", layers: ["project"] },
    work: [],
    events: [],
    evidence: [],
    signals: [],
    knowledge: [
      {
        knowledgeId: "skill-demo",
        type: "document",
        layer: "project",
        title: "demo",
        description: "既有技能的匯入登記",
        pinned: false,
        source: "skill-draft",
        currentVersion: 1,
        versions: [{ version: 1, body: "---\nname: demo\n---\n\n# Demo\n" }],
      },
    ],
    mapping: [],
    raw: [],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

describe("既有技能", () => {
  test("同名技能只登記知識，不覆寫實體技能資料夾", async () => {
    const root = makeTempDir("import-skill");
    const packageDir = join(root, "package");
    const skillsDir = join(root, "agents-skills");
    try {
      skillPackage(packageDir);
      mkdirSync(join(skillsDir, "demo"), { recursive: true });
      const skillPath = join(skillsDir, "demo", "SKILL.md");
      writeFileSync(skillPath, "---\nname: demo\ndescription: 使用者既有版本\n---\n\n# 保留我\n", "utf8");
      const before = scanHashes(skillsDir);

      await withTempHome("import-skill-home", async (home) => {
        const result = importPackage({ packageDir, home, globalSkillsDir: skillsDir });
        expect(result.warnings.some((warning) => warning.includes("EXISTING_SKILL_REGISTERED"))).toBe(
          true,
        );

        const db = openDatabase({ home });
        try {
          const entry = db
            .query<{ kind: string; title: string; source: string }, []>(
              "SELECT kind, title, source FROM knowledge_entries",
            )
            .get();
          expect(entry).toEqual({ kind: "skill", title: "demo", source: "skill-draft" });
        } finally {
          db.close();
        }
      });

      expect(scanHashes(skillsDir)).toEqual(before);
      expect(readFileSync(skillPath, "utf8")).toContain("保留我");
    } finally {
      removeDir(root);
    }
  });
});
