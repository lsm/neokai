/**
 * Config Tests
 *
 * Tests for the configuration module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getConfig } from "../../../src/config";

describe("getConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };
    // Clear LIUBOER_WORKSPACE_PATH to avoid test pollution
    delete process.env.LIUBOER_WORKSPACE_PATH;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  test("returns default values when no overrides or env vars", () => {
    // Clear relevant env vars
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.DB_PATH;
    delete process.env.DEFAULT_MODEL;
    delete process.env.MAX_TOKENS;
    delete process.env.TEMPERATURE;
    delete process.env.MAX_SESSIONS;
    process.env.NODE_ENV = "production";

    const config = getConfig({ workspace: "/test/workspace" });

    expect(config.port).toBe(9283);
    expect(config.host).toBe("0.0.0.0");
    // Database path should be project-based: ~/.liuboer/projects/{encoded-workspace}/database/daemon.db
    expect(config.dbPath).toContain(".liuboer/projects");
    expect(config.dbPath).toContain("-test-workspace");
    expect(config.dbPath).toEndWith("database/daemon.db");
    // 'default' maps to Sonnet 4.5 in the SDK
    expect(config.defaultModel).toBe("default");
    expect(config.maxTokens).toBe(8192);
    expect(config.temperature).toBe(1.0);
    expect(config.maxSessions).toBe(10);
    expect(config.nodeEnv).toBe("production");
    expect(config.workspaceRoot).toBe("/test/workspace");
  });

  test("uses environment variables when set", () => {
    process.env.PORT = "8080";
    process.env.HOST = "127.0.0.1";
    process.env.DB_PATH = "/custom/path/db.sqlite";
    process.env.DEFAULT_MODEL = "claude-opus-4-20250514";
    process.env.MAX_TOKENS = "4096";
    process.env.TEMPERATURE = "0.5";
    process.env.MAX_SESSIONS = "20";
    process.env.NODE_ENV = "production";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig();

    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.dbPath).toBe("/custom/path/db.sqlite");
    expect(config.defaultModel).toBe("claude-opus-4-20250514");
    expect(config.maxTokens).toBe(4096);
    expect(config.temperature).toBe(0.5);
    expect(config.maxSessions).toBe(20);
    expect(config.workspaceRoot).toBe("/env/workspace");
  });

  test("CLI port override takes precedence over env var", () => {
    process.env.PORT = "8080";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig({ port: 3000 });

    expect(config.port).toBe(3000);
  });

  test("CLI host override takes precedence over env var", () => {
    process.env.HOST = "127.0.0.1";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig({ host: "localhost" });

    expect(config.host).toBe("localhost");
  });

  test("CLI dbPath override takes precedence over env var", () => {
    process.env.DB_PATH = "/env/path/db.sqlite";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig({ dbPath: "/cli/path/db.sqlite" });

    expect(config.dbPath).toBe("/cli/path/db.sqlite");
  });

  test("CLI workspace override takes precedence over LIUBOER_WORKSPACE_PATH env var", () => {
    process.env.NODE_ENV = "production";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig({ workspace: "/custom/workspace" });

    expect(config.workspaceRoot).toBe("/custom/workspace");
  });

  test("LIUBOER_WORKSPACE_PATH environment variable is used when set", () => {
    process.env.NODE_ENV = "production";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig();

    expect(config.workspaceRoot).toBe("/env/workspace");
  });

  test("throws error when no workspace is provided", () => {
    process.env.NODE_ENV = "production";
    // No LIUBOER_WORKSPACE_PATH env var set

    expect(() => getConfig()).toThrow(
      "Workspace path must be explicitly provided via --workspace flag or LIUBOER_WORKSPACE_PATH environment variable",
    );
  });

  test("reads API key from env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig();

    expect(config.anthropicApiKey).toBe("sk-test-key");
  });

  test("reads OAuth token from env var", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token-123";
    process.env.LIUBOER_WORKSPACE_PATH = "/env/workspace";

    const config = getConfig();

    expect(config.claudeCodeOAuthToken).toBe("oauth-token-123");
  });

  test("generates project-based database path with encoded workspace path", () => {
    delete process.env.DB_PATH;
    process.env.NODE_ENV = "production";

    const config = getConfig({ workspace: "/Users/alice/my_project" });

    // Should encode path: /Users/alice/my_project → -Users-alice-my_project
    expect(config.dbPath).toContain(
      ".liuboer/projects/-Users-alice-my_project/database/daemon.db",
    );
  });

  test("handles Windows-style paths in database path generation", () => {
    delete process.env.DB_PATH;
    process.env.NODE_ENV = "production";

    // Windows path with backslashes
    const config = getConfig({ workspace: "C:\\Users\\bob\\project" });

    // Should normalize and encode: C:\Users\bob\project → -C:-Users-bob-project
    // Note: The colon is preserved in Windows drive letters
    expect(config.dbPath).toContain(
      ".liuboer/projects/-C:-Users-bob-project/database/daemon.db",
    );
  });

  test("DB_PATH env var takes precedence over auto-generated path", () => {
    process.env.DB_PATH = "/custom/database.db";
    process.env.LIUBOER_WORKSPACE_PATH = "/workspace";

    const config = getConfig();

    expect(config.dbPath).toBe("/custom/database.db");
  });
});
