/**
 * EnvManager Tests
 *
 * Tests the environment file manager to ensure credentials are
 * properly written to .env file and not stored in database.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EnvManager } from "../src/lib/env-manager";
import { unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("EnvManager", () => {
  const testEnvPath = join(process.cwd(), "tests", "fixtures", ".env.test");
  let envManager: EnvManager;

  beforeEach(() => {
    // Create test directory if it doesn't exist
    const testDir = join(process.cwd(), "tests", "fixtures");
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up test env file
    if (existsSync(testEnvPath)) {
      unlinkSync(testEnvPath);
    }

    envManager = new EnvManager(testEnvPath);
  });

  afterEach(() => {
    // Clean up test env file
    if (existsSync(testEnvPath)) {
      unlinkSync(testEnvPath);
    }
  });

  describe("setApiKey", () => {
    test("should write API key to .env file", () => {
      const apiKey = "sk-ant-api-test-key";

      envManager.setApiKey(apiKey);

      // Verify file was created
      expect(existsSync(testEnvPath)).toBe(true);

      // Read and verify contents
      const content = readFileSync(testEnvPath, "utf-8");
      expect(content).toContain(`ANTHROPIC_API_KEY=${apiKey}`);
      expect(content).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    });

    test("should update process.env", () => {
      const apiKey = "sk-ant-api-test-key";
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        envManager.setApiKey(apiKey);

        expect(process.env.ANTHROPIC_API_KEY).toBe(apiKey);
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      } finally {
        // Restore original env vars
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }

        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });

    test("should clear OAuth token when setting API key", () => {
      // First set OAuth token
      envManager.setOAuthToken("sk-ant-oat-test-token");

      // Then set API key
      envManager.setApiKey("sk-ant-api-test-key");

      // Verify OAuth token is cleared
      const content = readFileSync(testEnvPath, "utf-8");
      expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-api-test-key");
      expect(content).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token");
    });
  });

  describe("setOAuthToken", () => {
    test("should write OAuth token to .env file", () => {
      const oauthToken = "sk-ant-oat-test-token";

      envManager.setOAuthToken(oauthToken);

      // Verify file was created
      expect(existsSync(testEnvPath)).toBe(true);

      // Read and verify contents
      const content = readFileSync(testEnvPath, "utf-8");
      expect(content).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
      expect(content).not.toContain("ANTHROPIC_API_KEY=");
    });

    test("should update process.env", () => {
      const oauthToken = "sk-ant-oat-test-token";
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        envManager.setOAuthToken(oauthToken);

        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(oauthToken);
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        // Restore original env vars
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }

        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });

    test("should clear API key when setting OAuth token", () => {
      // First set API key
      envManager.setApiKey("sk-ant-api-test-key");

      // Then set OAuth token
      envManager.setOAuthToken("sk-ant-oat-test-token");

      // Verify API key is cleared
      const content = readFileSync(testEnvPath, "utf-8");
      expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token");
      expect(content).not.toContain("ANTHROPIC_API_KEY=sk-ant-api-test-key");
    });
  });

  describe("clearCredentials", () => {
    test("should remove all credentials from .env file", () => {
      // Set credentials first
      envManager.setApiKey("sk-ant-api-test-key");

      // Clear credentials
      envManager.clearCredentials();

      // Verify credentials are removed
      const content = readFileSync(testEnvPath, "utf-8");
      expect(content).not.toContain("ANTHROPIC_API_KEY=sk-ant-api-test-key");
      expect(content).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    });

    test("should update process.env", () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Set credentials
        envManager.setApiKey("sk-ant-api-test-key");

        // Clear credentials
        envManager.clearCredentials();

        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      } finally {
        // Restore original env vars
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        }

        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        }
      }
    });
  });

  describe("getApiKey and getOAuthToken", () => {
    test("should read from process.env", () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        process.env.ANTHROPIC_API_KEY = "test-api-key";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";

        expect(envManager.getApiKey()).toBe("test-api-key");
        expect(envManager.getOAuthToken()).toBe("test-oauth-token");
      } finally {
        // Restore original env vars
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }

        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });
  });

  describe("hasCredentials", () => {
    test("should return true when API key is set", () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;

      try {
        process.env.ANTHROPIC_API_KEY = "test-key";

        expect(envManager.hasCredentials()).toBe(true);
      } finally {
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });

    test("should return true when OAuth token is set", () => {
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

        expect(envManager.hasCredentials()).toBe(true);
      } finally {
        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });

    test("should return false when no credentials are set", () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

        expect(envManager.hasCredentials()).toBe(false);
      } finally {
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        }

        if (originalOAuthToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        }
      }
    });
  });
});
