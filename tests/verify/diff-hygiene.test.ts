import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectWorkspaceChanges,
  DIFF_HYGIENE_RULES,
  evaluateDiffHygiene,
  isPathInScope,
  scanLine,
  scanUnifiedDiff,
} from "../../src/verify/diff-hygiene.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SmileWork Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "SmileWork Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失敗：${result.stderr}`);
  return result.stdout.toString().trim();
}

describe("規則掃描", () => {
  const cases: Array<[string, string]> = [
    ["ts-ignore", "// @ts-ignore"],
    ["ts-expect-error", "// @ts-expect-error wrong types"],
    ["ts-nocheck", "// @ts-nocheck"],
    ["eslint-disable", "/* eslint-disable no-console */"],
    ["biome-ignore", "// biome-ignore lint/style: reason"],
    ["istanbul-ignore", "/* istanbul ignore next */"],
    ["c8-ignore", "/* c8 ignore next */"],
    ["v8-ignore", "/* v8 ignore start */"],
    ["test-skip", 'it.skip("x", () => {})'],
    ["test-skip", 'describe.todo ("later")'],
    ["junit-disabled", "@Disabled"],
    ["pytest-skip", "@pytest.mark.skipif(True, reason='x')"],
    ["rust-ignore", "#[ignore]"],
    ["rust-allow", "#[allow(dead_code)]"],
    ["noqa", "import os  # noqa: F401"],
    ["type-ignore", "x = 1  # type: ignore[assignment]"],
  ];

  for (const [rule, line] of cases) {
    test(`${rule}: ${line}`, () => {
      expect(scanLine("a.ts", 3, line).map((finding) => finding.rule)).toContain(rule);
    });
  }

  test("一般程式碼不會誤判", () => {
    for (const line of [
      "const skip = test.only ? 1 : 0;",
      "const disabled = true;",
      "// 說明為什麼不用 ignore",
      "test('runs', () => {})",
    ]) {
      expect(scanLine("a.ts", 1, line)).toEqual([]);
    }
  });

  test("每條規則名稱都不重複", () => {
    const names = DIFF_HYGIENE_RULES.map((rule) => rule.rule);
    expect(new Set(names).size).toBe(names.length);
  });

  test("unified diff 只掃新增的行並回報新檔行號", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,1 +3,2 @@",
      "-// @ts-ignore 舊的被刪掉",
      "+const ok = 1;",
      "+// @ts-expect-error 新增",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-// eslint-disable",
    ].join("\n");
    expect(scanUnifiedDiff(diff)).toEqual([
      { rule: "ts-expect-error", path: "src/a.ts", line: 4, snippet: "// @ts-expect-error 新增" },
    ]);
  });
});

describe("scopePaths 與 ruling 豁免", () => {
  test("完全相同或資料夾前綴才算在範圍內", () => {
    expect(isPathInScope("src/work/crud.ts", ["src/work/"])).toBe(true);
    expect(isPathInScope("src/work/crud.ts", ["./src/work"])).toBe(true);
    expect(isPathInScope("src/work/crud.ts", ["src/work/crud.ts"])).toBe(true);
    expect(isPathInScope("src/workflow.ts", ["src/work"])).toBe(false);
    expect(isPathInScope("README.md", [])).toBe(true);
    expect(isPathInScope("README.md", ["."])).toBe(true);
  });

  test("ruling 提到規則名只放行該規則；diff-hygiene 與 scope-override 是整體豁免", () => {
    const changes = {
      baseRef: "HEAD",
      baseSource: "HEAD" as const,
      files: ["src/a.ts", "docs/x.md"],
      findings: [
        { rule: "ts-ignore", path: "src/a.ts", line: 1, snippet: "// @ts-ignore" },
        { rule: "noqa", path: "src/a.ts", line: 2, snippet: "# noqa" },
      ],
    };
    const none = evaluateDiffHygiene(changes, { scopePaths: ["src"], rulings: [] });
    expect(none.findings).toHaveLength(2);
    expect(none.scopeViolations).toEqual(["docs/x.md"]);

    const partial = evaluateDiffHygiene(changes, {
      scopePaths: ["src"],
      rulings: [{ decision: "保留 @ts-ignore：上游型別錯誤", rationale: "已回報上游" }],
    });
    expect(partial.findings.map((finding) => finding.rule)).toEqual(["noqa"]);
    expect(partial.exemptedFindings).toBe(1);

    // 規則名稱必須完整出現，不能用前綴碰巧命中。
    const prefix = evaluateDiffHygiene(changes, {
      scopePaths: ["src"],
      rulings: [{ decision: "ts-ignored-later 不算", rationale: "x" }],
    });
    expect(prefix.findings).toHaveLength(2);

    const blanket = evaluateDiffHygiene(changes, {
      scopePaths: ["src"],
      rulings: [
        { decision: "diff-hygiene 例外：產生的程式碼", rationale: "由工具產生" },
        { decision: "x", rationale: "y", costIfWrong: "scope-override 文件一起更新" },
      ],
    });
    expect(blanket).toEqual({
      findings: [],
      scopeViolations: [],
      exemptedFindings: 2,
      exemptedScopeViolations: 1,
    });
  });
});

describe("collectWorkspaceChanges", () => {
  test("不是 git repo 時回 null", async () => {
    await withTempDir("hygiene-plain", async (root) => {
      expect(collectWorkspaceChanges(root, null)).toBeNull();
    });
  });

  test("以 baseCommit 為基準，包含已提交、暫存、未暫存與未追蹤的改動", async () => {
    await withTempDir("hygiene-repo", async (root) => {
      const repo = await createGitRepo(join(root, "repo"));
      const base = git(repo, ["rev-parse", "HEAD"]);

      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "committed.ts"), "// @ts-nocheck\nexport {};\n", "utf8");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "after base"]);
      writeFileSync(join(repo, "README.md"), "# fixture\n/* eslint-disable */\n", "utf8");
      writeFileSync(join(repo, "src", "untracked.py"), "import os  # noqa\n", "utf8");
      writeFileSync(join(repo, ".gitignore"), "ignored/\n", "utf8");
      mkdirSync(join(repo, "ignored"), { recursive: true });
      writeFileSync(join(repo, "ignored", "x.ts"), "// @ts-ignore\n", "utf8");

      const fromBase = collectWorkspaceChanges(repo, base);
      expect(fromBase?.baseSource).toBe("baseCommit");
      expect(fromBase?.files).toEqual([".gitignore", "README.md", "src/committed.ts", "src/untracked.py"]);
      expect(fromBase?.findings).toEqual([
        { rule: "eslint-disable", path: "README.md", line: 2, snippet: "/* eslint-disable */" },
        { rule: "ts-nocheck", path: "src/committed.ts", line: 1, snippet: "// @ts-nocheck" },
        { rule: "noqa", path: "src/untracked.py", line: 1, snippet: "import os  # noqa" },
      ]);

      // baseCommit 無效時退回 HEAD：已提交的改動不再列入。
      const fallback = collectWorkspaceChanges(repo, "0123456789abcdef0123456789abcdef01234567");
      expect(fallback?.baseSource).toBe("HEAD");
      expect(fallback?.files).toEqual([".gitignore", "README.md", "src/untracked.py"]);
      expect(collectWorkspaceChanges(repo, "--output=/tmp/x")?.baseSource).toBe("HEAD");
    });
  });

  test("專案根目錄是 repo 子資料夾時只看子資料夾，路徑相對於專案根目錄", async () => {
    await withTempDir("hygiene-subdir", async (root) => {
      const repo = await createGitRepo(join(root, "repo"));
      const project = join(repo, "packages", "app");
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src", "a.ts"), "// @ts-ignore\n", "utf8");
      writeFileSync(join(repo, "outside.ts"), "// @ts-ignore\n", "utf8");

      const changes = collectWorkspaceChanges(project, null);
      expect(changes?.files).toEqual(["src/a.ts"]);
      expect(changes?.findings.map((finding) => finding.path)).toEqual(["src/a.ts"]);
    });
  });
});
