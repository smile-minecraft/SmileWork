import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import { createTranscriptIndex, createUserSkill, parseJson, runCli, withCliEnvironment } from "./helpers.ts";
import { createGitRepo } from "../helpers/git.ts";

interface DoctorCheck {
  name: string;
  status: "ok" | "warn";
  detail: string;
  nextAction: string | null;
}

interface DoctorPayload {
  ok: boolean;
  exitCode: number;
  checks: DoctorCheck[];
  report: {
    database: { status: string };
    project: { status: string };
    actor: { declared: boolean };
    profile: { name: string; configured: boolean };
    skills: { status: string };
    transcripts: { status: string };
  };
}

function findCheck(payload: DoctorPayload, name: string): DoctorCheck | undefined {
  return payload.checks.find((check) => check.name === name);
}

function healthyDatabase(home: string): void {
  const db = openDatabase({ path: join(home, "smilework.db") });
  db.close();
}

describe("doctor 子命令", () => {
  test("健康環境以 0 結束，所有檢查都通過", async () => {
    await withCliEnvironment("cli-doctor-ok", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.exitCode).toBe(0);
      expect(payload.checks.length).toBeGreaterThanOrEqual(6);
      expect(payload.checks.every((check) => check.status === "ok")).toBe(true);
      expect(findCheck(payload, "資料庫")?.status).toBe("ok");
      expect(findCheck(payload, "專案")?.status).toBe("ok");
      expect(findCheck(payload, "actor")?.status).toBe("ok");
      expect(findCheck(payload, "技能連結")?.status).toBe("ok");
      expect(findCheck(payload, "對話索引")?.status).toBe("ok");
    });
  }, 30_000);

  test("資料庫與索引缺失時輸出警告與非零結束碼，且不建立資料庫", async () => {
    await withCliEnvironment("cli-doctor-missing", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      await createUserSkill(context.userHome, "alpha");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.ok).toBe(false);
      expect(findCheck(payload, "資料庫")).toMatchObject({ status: "warn" });
      expect(findCheck(payload, "對話索引")).toMatchObject({ status: "warn" });
      expect(payload.report.database.status).toBe("missing");
      expect(payload.report.transcripts.status).toBe("not_indexed");
      expect(existsSync(join(context.home, "smilework.db"))).toBe(false);
    });
  }, 30_000);

  test("專案路徑不存在時回警告與非零結束碼", async () => {
    await withCliEnvironment("cli-doctor-project", async (context) => {
      const plain = join(context.root, "plain");
      await mkdir(plain, { recursive: true });
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
        SMILEWORK_PROJECT: join(context.root, "missing-project"),
      };

      const result = await runCli(["doctor", "--json"], env, plain);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(findCheck(payload, "專案")).toMatchObject({ status: "warn" });
      expect(findCheck(payload, "專案")?.nextAction).toContain("SMILEWORK_PROJECT");
    });
  }, 30_000);

  test("非 git 目錄以路徑專案通過專案檢查", async () => {
    await withCliEnvironment("cli-doctor-path-project", async (context) => {
      const plain = join(context.root, "plain");
      await mkdir(plain, { recursive: true });
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, plain);

      const payload = parseJson<DoctorPayload>(result.stdout);
      const projectCheck = findCheck(payload, "專案");
      expect(projectCheck).toMatchObject({ status: "ok" });
      expect(projectCheck?.detail).toContain("路徑專案");
    });
  }, 30_000);

  test("actor 未設定時回警告與設定提示", async () => {
    await withCliEnvironment("cli-doctor-actor", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");

      const result = await runCli(["doctor", "--json"], context.env, repo);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.actor.declared).toBe(false);
      expect(findCheck(payload, "actor")).toMatchObject({ status: "warn" });
      expect(findCheck(payload, "actor")?.nextAction).toContain("SMILEWORK_ACTOR");
    });
  }, 30_000);

  test("技能未連結時回警告與 link 提示", async () => {
    await withCliEnvironment("cli-doctor-skills", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha", { link: false });
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.skills.status).toBe("not_linked");
      expect(findCheck(payload, "技能連結")).toMatchObject({ status: "warn" });
      expect(findCheck(payload, "技能連結")?.nextAction).toContain("smilework link");
    });
  }, 30_000);

  test("SMILEWORK_HOME 指向檔案時設定檢查回警告，不拋出例外", async () => {
    await withCliEnvironment("cli-doctor-config", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      const occupied = join(context.root, "not-a-directory");
      writeFileSync(occupied, "occupied", "utf8");
      const env = {
        ...context.env,
        SMILEWORK_HOME: occupied,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(findCheck(payload, "設定")).toMatchObject({ status: "warn" });
      expect(result.stderr).not.toContain("Error");
    });
  }, 30_000);

  test("全域設定檔的 profile=full 顯示在設定檢查", async () => {
    await withCliEnvironment("cli-doctor-profile-global", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      writeFileSync(join(context.home, "config.jsonc"), `{"profile": "full"}\n`, "utf8");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.profile).toEqual({ name: "full", configured: true });
      const configCheck = findCheck(payload, "設定");
      expect(configCheck).toMatchObject({ status: "ok" });
      expect(configCheck?.detail).toContain("profile：full");
      expect(configCheck?.detail).not.toContain("worker");
      expect(configCheck?.detail).not.toContain("不認得的");
    });
  }, 30_000);

  test("SMILEWORK_PROFILE 優先於全域設定檔的 profile", async () => {
    await withCliEnvironment("cli-doctor-profile-precedence", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      writeFileSync(join(context.home, "config.jsonc"), `{"profile": "full"}\n`, "utf8");
      const env = {
        ...context.env,
        SMILEWORK_PROFILE: "curator",
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.profile).toEqual({ name: "curator", configured: true });
      expect(findCheck(payload, "設定")?.detail).toContain("profile：curator");
    });
  }, 30_000);

  test("沒有 SMILEWORK_PROFILE 與設定檔時，設定檢查顯示預設 worker", async () => {
    await withCliEnvironment("cli-doctor-profile-default", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      healthyDatabase(context.home);
      createTranscriptIndex(context.home);
      await createUserSkill(context.userHome, "alpha");
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.profile).toEqual({ name: "worker", configured: false });
      expect(findCheck(payload, "設定")?.detail).toContain("profile：worker");
    });
  }, 30_000);

  test("不認得的 SMILEWORK_PROFILE 仍回警告與設定提示", async () => {
    await withCliEnvironment("cli-doctor-profile-invalid", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      const env = {
        ...context.env,
        SMILEWORK_PROFILE: "bogus",
      };

      const result = await runCli(["doctor", "--json"], env, repo);

      expect(result.exitCode).toBe(1);
      const payload = parseJson<DoctorPayload>(result.stdout);
      const configCheck = findCheck(payload, "設定");
      expect(configCheck).toMatchObject({ status: "warn" });
      expect(configCheck?.detail).toContain("bogus");
      expect(configCheck?.nextAction).toContain("SMILEWORK_PROFILE");
    });
  }, 30_000);
});
