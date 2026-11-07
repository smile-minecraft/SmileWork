import { describe, expect, test } from "bun:test";
import { containsSecret, redactSecrets, assertNoSecrets } from "../../src/shared/secrets.ts";

// 全部是刻意構造的假值，只用來驗證格式偵測。
const FAKE_OPENAI = "sk-test-placeholder-5fyvm3kp";
const FAKE_GITHUB = "ghp_fakemiym7vfgqwertyuiop123456";
const FAKE_AWS = "AKIA" + "FAKETESTW6PZHLBE";
const FAKE_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
const FAKE_PASSWORD = 'password = "SECRET_usoj7rm6placeholder"';

describe("機密偵測與遮蔽", () => {
  test("偵測常見的假 token", () => {
    expect(containsSecret(FAKE_OPENAI)).toBe(true);
    expect(containsSecret(FAKE_GITHUB)).toBe(true);
    expect(containsSecret(FAKE_AWS)).toBe(true);
    expect(containsSecret(FAKE_PRIVATE_KEY)).toBe(true);
    expect(containsSecret(FAKE_PASSWORD)).toBe(true);
  });

  test("一般文字不會誤判", () => {
    expect(containsSecret("這是一段普通的說明，沒有憑證。")).toBe(false);
    expect(containsSecret("password = short")).toBe(false);
    expect(containsSecret("https://example.com/docs")).toBe(false);
  });

  test("redactSecrets 不留下原始內容", () => {
    const text = `token=${FAKE_OPENAI}\n${FAKE_PRIVATE_KEY}`;
    const redacted = redactSecrets(text);

    expect(redacted).not.toContain(FAKE_OPENAI);
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).toContain("[REDACTED]");
  });

  test("assertNoSecrets 的錯誤不包含命中的內容", () => {
    let error: unknown;
    try {
      assertNoSecrets(`api_key=${FAKE_OPENAI}`, "body");
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "SECRET_DETECTED" });
    expect((error as Error).message).not.toContain(FAKE_OPENAI);
    expect((error as Error).message).toContain("body");
  });
});
