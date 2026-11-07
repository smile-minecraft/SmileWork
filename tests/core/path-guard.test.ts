import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertLinkTarget,
  assertPathAllowed,
  guardRoots,
  isPathAllowed,
  isSensitivePath,
  resolveWithinRoot,
} from "../../src/shared/path-guard.ts";
import { withTempDir } from "../helpers/temp.ts";

describe("path-guard", () => {
  test("允許 smilework home、全域技能與專案技能三個根目錄", async () => {
    await withTempDir("guard-allow", async (root) => {
      const home = join(root, "user");
      const smilework = join(home, ".smilework");
      const project = join(root, "project");
      const roots = guardRoots({
        home,
        smileworkHome: smilework,
        projectPath: project,
        includeLinkRoot: true,
      });

      expect(assertPathAllowed(join(smilework, "knowledge-store", "a.md"), roots)).toBe(
        join(smilework, "knowledge-store", "a.md"),
      );
      expect(assertPathAllowed(join(home, ".agents", "skills", "skill-a", "SKILL.md"), roots)).toBe(
        join(home, ".agents", "skills", "skill-a", "SKILL.md"),
      );
      expect(assertPathAllowed(join(project, ".agents", "skills", "skill-b", "SKILL.md"), roots)).toBe(
        join(project, ".agents", "skills", "skill-b", "SKILL.md"),
      );
      expect(assertPathAllowed(join(home, ".claude", "skills", "skill-a"), roots)).toBe(
        join(home, ".claude", "skills", "skill-a"),
      );
    });
  });

  test("以 .. 逃逸根目錄被拒絕", async () => {
    await withTempDir("guard-dotdot", async (root) => {
      const home = join(root, "user");
      const roots = guardRoots({ home, smileworkHome: join(home, ".smilework") });

      expect(() => assertPathAllowed(join(home, ".smilework", "..", "..", "etc", "passwd"), roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      
    });
  });

  test("絕對路徑落在允許根之外被拒絕", async () => {
    await withTempDir("guard-absolute", async (root) => {
      const home = join(root, "user");
      const roots = guardRoots({ home, smileworkHome: join(home, ".smilework") });
      const outside = join(root, "outside", "secret.txt");

      expect(() => assertPathAllowed(outside, roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      expect(isPathAllowed(outside, roots)).toBe(false);
    });
  });

  test("指向允許根之外的 symlink 被拒絕", async () => {
    await withTempDir("guard-symlink", async (root) => {
      const home = join(root, "user");
      const smilework = join(home, ".smilework");
      const outside = join(root, "outside");
      await mkdir(smilework, { recursive: true });
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(smilework, "escape"));

      const roots = guardRoots({ home, smileworkHome: smilework });

      expect(() => assertPathAllowed(join(smilework, "escape", "secret.txt"), roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
    });
  });

  test("dangling symlink 一律拒絕", async () => {
    await withTempDir("guard-dangling", async (root) => {
      const home = join(root, "user");
      const smilework = join(home, ".smilework");
      await mkdir(smilework, { recursive: true });
      await symlink(join(root, "missing-target"), join(smilework, "dangling"));
      const roots = guardRoots({ home, smileworkHome: smilework });

      expect(() => assertPathAllowed(join(smilework, "dangling"), roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      expect(() => assertPathAllowed(join(smilework, "dangling", "file.md"), roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      expect(isPathAllowed(join(smilework, "dangling"), roots)).toBe(false);
    });
  });

  test("指向同一允許根內部的 symlink 可以使用", async () => {
    await withTempDir("guard-symlink-inside", async (root) => {
      const home = join(root, "user");
      const smilework = join(home, ".smilework");
      const real = join(smilework, "real");
      await mkdir(real, { recursive: true });
      await symlink(real, join(smilework, "alias"));
      const roots = guardRoots({ home, smileworkHome: smilework });

      expect(assertPathAllowed(join(smilework, "alias", "a.md"), roots)).toBe(
        join(smilework, "alias", "a.md"),
      );
    });
  });

  test("resolveWithinRoot 拒絕絕對路徑與 .. 區段", async () => {
    await withTempDir("guard-relative", async (root) => {
      const base = join(root, "base");
      await mkdir(base, { recursive: true });

      expect(resolveWithinRoot(base, "nested/file.md")).toBe(join(base, "nested", "file.md"));
      expect(() => resolveWithinRoot(base, "/etc/passwd")).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      expect(() => resolveWithinRoot(base, "../escape.md")).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
    });
  });

  test("link 目標必須落在全域技能根，link 路徑必須落在 link 根", async () => {
    await withTempDir("guard-link", async (root) => {
      const home = join(root, "user");
      const roots = guardRoots({ home, smileworkHome: join(home, ".smilework"), includeLinkRoot: true });
      const skill = join(home, ".agents", "skills", "skill-a");
      const link = join(home, ".claude", "skills", "skill-a");
      await mkdir(skill, { recursive: true });
      await mkdir(join(home, ".claude", "skills"), { recursive: true });

      expect(() => assertLinkTarget(link, skill, roots)).not.toThrow();
      await symlink(join("..", "..", ".agents", "skills", "skill-a"), link);
      expect(() => assertLinkTarget(link, skill, roots)).not.toThrow();
      expect(() => assertLinkTarget(join(home, ".claude", "skills", "skill-b"), join(root, "outside"), roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      expect(() => assertLinkTarget(join(root, "elsewhere", "skill-a"), skill, roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
      await mkdir(join(home, ".claude", "skills", "skill-real"), { recursive: true });
      expect(() => assertLinkTarget(join(home, ".claude", "skills", "skill-real"), skill, roots)).toThrow(
        expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
      );
    });
  });

  test("敏感檔名判斷不分大小寫，且豁免 .env.example", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.local")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("keys/id_rsa")).toBe(true);
    expect(isSensitivePath("certs/server.PEM")).toBe(true);
    expect(isSensitivePath("notes/readme.md")).toBe(false);
  });
});
