/**
 * System API Integration Tests
 *
 * Tests system-level endpoints:
 * - GET /api/health
 * - GET /api/config
 * - CORS handling
 */

import { describe, test, expect } from "bun:test";
import type { DaemonConfig, HealthStatus } from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  assertEquals,
  assertExists,
  assertGreaterThan,
  assertTrue,
  hasAnyCredentials,
} from "./test-utils";

describe("System API", () => {
  describe("GET /api/health", () => {
    test("should return health status", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/health");
        const health = await assertSuccessResponse<HealthStatus>(response);

        assertEquals(health.status, "ok");
        assertExists(health.version);
        assertExists(health.uptime);
        assertEquals(typeof health.uptime, "number");
        assertGreaterThan(health.uptime, 0);
        assertExists(health.sessions);
        assertEquals(health.sessions.active, 0);
        assertEquals(health.sessions.total, 0);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should track active sessions", async () => {
      const ctx = await createTestApp();
      try {
        // Create a session
        await request(ctx.baseUrl, "POST", "/api/sessions", {});

        const response = await request(ctx.baseUrl, "GET", "/api/health");
        const health = await assertSuccessResponse<HealthStatus>(response);

        assertEquals(health.status, "ok");
        assertEquals(health.sessions.active, 1);
        assertEquals(health.sessions.total, 1);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should track multiple sessions", async () => {
      const ctx = await createTestApp();
      try {
        // Create multiple sessions
        await request(ctx.baseUrl, "POST", "/api/sessions", {});
        await request(ctx.baseUrl, "POST", "/api/sessions", {});
        await request(ctx.baseUrl, "POST", "/api/sessions", {});

        const response = await request(ctx.baseUrl, "GET", "/api/health");
        const health = await assertSuccessResponse<HealthStatus>(response);

        assertEquals(health.sessions.active, 3);
        assertEquals(health.sessions.total, 3);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should increment uptime", async () => {
      const ctx = await createTestApp();
      try {
        const response1 = await request(ctx.baseUrl, "GET", "/api/health");
        const health1 = await assertSuccessResponse<HealthStatus>(response1);

        // Wait a bit
        await Bun.sleep(100);

        const response2 = await request(ctx.baseUrl, "GET", "/api/health");
        const health2 = await assertSuccessResponse<HealthStatus>(response2);

        assertGreaterThan(health2.uptime, health1.uptime);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/config", () => {
    test("should return daemon configuration", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/config");
        const config = await assertSuccessResponse<DaemonConfig>(response);

        assertEquals(config.defaultModel, "claude-sonnet-4-20250514");
        assertEquals(config.maxSessions, 10);
        assertExists(config.version);
        assertExists(config.claudeSDKVersion);
        assertExists(config.storageLocation);
        assertExists(config.authMethod);
        assertExists(config.authStatus);
      } finally {
        await ctx.cleanup();
      }
    });

    test.skipIf(!hasAnyCredentials())("should include auth status in config", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/config");
        const config = await assertSuccessResponse<DaemonConfig>(response);

        assertExists(config.authStatus);
        assertEquals(config.authStatus.isAuthenticated, true);
        // Method depends on what's in .env
        assertTrue(
          config.authStatus.method === "oauth_token" ||
            config.authStatus.method === "api_key",
        );
        assertEquals(config.authMethod, config.authStatus.method);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should reflect auth changes in config", async () => {
      const ctx = await createTestApp();
      try {
        // Logout
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        const response = await request(ctx.baseUrl, "GET", "/api/config");
        const config = await assertSuccessResponse<DaemonConfig>(response);

        assertEquals(config.authStatus.isAuthenticated, false);
        assertEquals(config.authStatus.method, "none");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /", () => {
    test("should return root endpoint info", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/");
        const result = await response.json();

        assertExists(result.name);
        assertExists(result.version);
        assertExists(result.status);
        assertEquals(result.status, "running");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("CORS Headers", () => {
    test("should include CORS headers in GET requests", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/health");

        assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should handle OPTIONS preflight requests", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "OPTIONS", "/api/health");

        assertEquals(response.status, 204);
        assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
        assertEquals(
          response.headers.get("Access-Control-Allow-Methods"),
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        assertEquals(
          response.headers.get("Access-Control-Allow-Headers"),
          "Content-Type",
        );
      } finally {
        await ctx.cleanup();
      }
    });

    test("should include CORS headers in POST requests", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          {},
        );

        assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should include CORS headers in error responses", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "GET",
          "/api/sessions/invalid-id",
        );

        assertEquals(response.status, 404);
        assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Error Handling", () => {
    test("should handle 404 errors", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "GET",
          "/api/nonexistent",
        );

        // Elysia returns 500 for unhandled routes, which is wrapped by error handler
        assertTrue(response.status === 404 || response.status === 500);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should handle invalid JSON in POST requests", async () => {
      const ctx = await createTestApp();
      try {
        const response = await fetch(`${ctx.baseUrl}/api/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: "invalid json {",
        });

        // Elysia's error handler wraps parse errors as 500
        assertTrue(response.status === 400 || response.status === 500);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
