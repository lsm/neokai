/**
 * Authentication Security Tests
 *
 * CRITICAL: Tests to ensure credentials are NEVER stored in the database.
 * Credentials should only be stored in environment variables and .env file.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../src/storage/database";
import { AuthManager } from "../src/lib/auth-manager";
import { EnvManager } from "../src/lib/env-manager";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";

describe("Authentication Security - Credentials Not In Database", () => {
  const testDbPath = ":memory:";
  const testEnvPath = join(process.cwd(), "tests", "fixtures", ".env.auth-test");
  let db: Database;
  let authManager: AuthManager;
  let config: Config;

  beforeEach(async () => {
    // Create test directory
    const testDir = join(process.cwd(), "tests", "fixtures");
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Clean up test env file
    if (existsSync(testEnvPath)) {
      unlinkSync(testEnvPath);
    }

    // Initialize database
    db = new Database(testDbPath);
    await db.initialize();

    // Create test config
    config = {
      host: "localhost",
      port: 8283,
      dbPath: testDbPath,
      defaultModel: "claude-sonnet-4-20250514",
      maxTokens: 8192,
      temperature: 1.0,
      maxSessions: 10,
      oauthAuthUrl: "https://console.anthropic.com/oauth/authorize",
      oauthTokenUrl: "https://console.anthropic.com/oauth/token",
      oauthClientId: "test-client-id",
      oauthRedirectUri: "http://localhost:3000/oauth/callback",
      oauthScopes: "public limited",
    };

    // Initialize auth manager with test env path
    authManager = new AuthManager(db, config, testEnvPath);
    await authManager.initialize();
  });

  afterEach(() => {
    // Clean up
    db.close();

    if (existsSync(testEnvPath)) {
      unlinkSync(testEnvPath);
    }
  });

  describe("CRITICAL: setApiKey should NOT store in database", () => {
    test("should write API key to .env file, NOT database", async () => {
      const testApiKey = "sk-ant-api-test-12345";

      // Set API key
      await authManager.setApiKey(testApiKey);

      // CRITICAL: Verify API key is NOT in database
      const dbApiKey = await db.getApiKey();
      expect(dbApiKey).toBeNull();

      // Verify .env file was created
      expect(existsSync(testEnvPath)).toBe(true);

      // Verify database auth method is cleared
      const authMethod = db.getAuthMethod();
      expect(authMethod).toBe("none");
    });

    test("should clear any existing database auth when setting API key", async () => {
      const testApiKey = "sk-ant-api-test-12345";

      // Simulate old behavior (storing in database) - this should be cleared
      await db.saveApiKey("old-api-key-in-db");
      expect(await db.getApiKey()).not.toBeNull();

      // Set API key via auth manager
      await authManager.setApiKey(testApiKey);

      // Verify database is cleared
      const dbApiKey = await db.getApiKey();
      expect(dbApiKey).toBeNull();
    });
  });

  describe("CRITICAL: setOAuthToken should NOT store in database", () => {
    test("should write OAuth token to .env file, NOT database", async () => {
      const testToken = "sk-ant-oat-test-12345";

      // Set OAuth token
      await authManager.setOAuthToken(testToken);

      // CRITICAL: Verify OAuth token is NOT in database
      const dbToken = await db.getOAuthLongLivedToken();
      expect(dbToken).toBeNull();

      // Verify .env file was created
      expect(existsSync(testEnvPath)).toBe(true);

      // Verify database auth method is cleared
      const authMethod = db.getAuthMethod();
      expect(authMethod).toBe("none");
    });

    test("should clear any existing database auth when setting OAuth token", async () => {
      const testToken = "sk-ant-oat-test-12345";

      // Simulate old behavior (storing in database) - this should be cleared
      await db.saveOAuthLongLivedToken("old-token-in-db");
      expect(await db.getOAuthLongLivedToken()).not.toBeNull();

      // Set OAuth token via auth manager
      await authManager.setOAuthToken(testToken);

      // Verify database is cleared
      const dbToken = await db.getOAuthLongLivedToken();
      expect(dbToken).toBeNull();
    });
  });

  describe("CRITICAL: getCurrentApiKey should read from env, NOT database", () => {
    test("should return OAuth token from environment", async () => {
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        const testToken = "sk-ant-oat-env-test";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = testToken;

        const currentKey = await authManager.getCurrentApiKey();
        expect(currentKey).toBe(testToken);

        // Verify it didn't come from database
        const dbToken = await db.getOAuthLongLivedToken();
        expect(dbToken).toBeNull();
      } finally {
        if (originalToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });

    test("should return API key from environment", async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Clear OAuth token first (it has higher priority)
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

        const testKey = "sk-ant-api-env-test";
        process.env.ANTHROPIC_API_KEY = testKey;

        const currentKey = await authManager.getCurrentApiKey();
        expect(currentKey).toBe(testKey);

        // Verify it didn't come from database
        const dbKey = await db.getApiKey();
        expect(dbKey).toBeNull();
      } finally {
        if (originalKey) {
          process.env.ANTHROPIC_API_KEY = originalKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }

        if (originalToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });

    test("should prefer env over database", async () => {
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Put token in both env and database
        const envToken = "sk-ant-oat-env-token";
        const dbToken = "sk-ant-oat-db-token";

        process.env.CLAUDE_CODE_OAUTH_TOKEN = envToken;
        await db.saveOAuthLongLivedToken(dbToken);

        // Should return env token, NOT database token
        const currentKey = await authManager.getCurrentApiKey();
        expect(currentKey).toBe(envToken);
        expect(currentKey).not.toBe(dbToken);
      } finally {
        if (originalToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    });
  });

  describe("CRITICAL: logout should clear env, NOT database", () => {
    test("should clear credentials from environment", () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Set credentials in environment
        process.env.ANTHROPIC_API_KEY = "test-key";
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";

        // Logout
        authManager.logout();

        // Verify environment is cleared
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      } finally {
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        }
        if (originalToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        }
      }
    });
  });

  describe("Database credential methods should still work (for OAuth flow only)", () => {
    test("database can still store OAuth flow tokens temporarily", async () => {
      // OAuth flow tokens (short-lived, temporary) can be stored in database
      const tokens = {
        accessToken: "temp-access-token",
        refreshToken: "temp-refresh-token",
        expiresAt: Date.now() + 3600000,
        tokenType: "Bearer" as const,
      };

      await db.saveOAuthTokens(tokens);

      const retrieved = await db.getOAuthTokens();
      expect(retrieved).not.toBeNull();
      expect(retrieved?.accessToken).toBe(tokens.accessToken);
    });

    test("getCurrentApiKey should use OAuth flow tokens as fallback", async () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      try {
        // Clear environment
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

        // Store OAuth flow tokens in database
        const tokens = {
          accessToken: "oauth-flow-access-token",
          refreshToken: "oauth-flow-refresh-token",
          expiresAt: Date.now() + 3600000,
          tokenType: "Bearer" as const,
        };

        await db.saveOAuthTokens(tokens);

        // Should return OAuth flow token from database as fallback
        const currentKey = await authManager.getCurrentApiKey();
        expect(currentKey).toBe(tokens.accessToken);
      } finally {
        if (originalApiKey) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        }
        if (originalToken) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        }
      }
    });
  });
});
