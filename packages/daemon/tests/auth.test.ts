/**
 * Authentication API Integration Tests
 *
 * Tests all authentication-related endpoints:
 * - GET /api/auth/status
 * - POST /api/auth/oauth/start
 * - POST /api/auth/oauth/complete
 * - POST /api/auth/api-key
 * - POST /api/auth/oauth-token
 * - POST /api/auth/refresh
 * - POST /api/auth/logout
 */

import { describe, test, expect } from "bun:test";
import type {
  GetAuthStatusResponse,
  StartOAuthFlowResponse,
  CompleteOAuthFlowRequest,
  SetApiKeyRequest,
  SetOAuthTokenRequest,
  RefreshTokenResponse,
} from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  assertErrorResponse,
  assertEquals,
  assertExists,
  assertTrue,
  assertNotEquals,
  hasAnyCredentials,
} from "./test-utils";

describe("Authentication API", () => {
  describe("GET /api/auth/status", () => {
    test.skipIf(!hasAnyCredentials())("should return auth status when authenticated", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/auth/status");
        const result =
          await assertSuccessResponse<GetAuthStatusResponse>(response);

        assertExists(result.authStatus);
        assertEquals(result.authStatus.isAuthenticated, true);
        // Method depends on what's in .env (oauth_token or api_key)
        assertTrue(
          result.authStatus.method === "oauth_token" ||
            result.authStatus.method === "api_key",
        );
      } finally {
        await ctx.cleanup();
      }
    });

    test("should return auth status when not authenticated", async () => {
      const ctx = await createTestApp();
      try {
        // Logout first
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        const response = await request(ctx.baseUrl, "GET", "/api/auth/status");
        const result =
          await assertSuccessResponse<GetAuthStatusResponse>(response);

        assertEquals(result.authStatus.isAuthenticated, false);
        assertEquals(result.authStatus.method, "none");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/api-key", () => {
    test("should set API key successfully", async () => {
      const ctx = await createTestApp();
      try {
        // Logout first
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        const body: SetApiKeyRequest = {
          apiKey: "sk-ant-test-key-123",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/api-key",
          body,
        );
        const result = await assertSuccessResponse<{ success: boolean }>(
          response,
        );

        assertEquals(result.success, true);

        // Verify auth status updated
        const statusResponse = await request(
          ctx.baseUrl,
          "GET",
          "/api/auth/status",
        );
        const status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.isAuthenticated, true);
        assertEquals(status.authStatus.method, "api_key");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail without API key", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/api-key",
          {},
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "Missing API key");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail with empty API key", async () => {
      const ctx = await createTestApp();
      try {
        const body: SetApiKeyRequest = {
          apiKey: "",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/api-key",
          body,
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "Missing API key");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/oauth/start", () => {
    test("should start OAuth flow", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth/start",
        );
        const result =
          await assertSuccessResponse<StartOAuthFlowResponse>(response);

        assertExists(result.authorizationUrl);
        assertExists(result.state);
        assertTrue(result.authorizationUrl.length > 0);
        assertTrue(result.state.length > 0);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/oauth/complete", () => {
    test("should fail with missing code", async () => {
      const ctx = await createTestApp();
      try {
        const body: Partial<CompleteOAuthFlowRequest> = {
          state: "test-state",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth/complete",
          body,
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "Missing code or state");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail with missing state", async () => {
      const ctx = await createTestApp();
      try {
        const body: Partial<CompleteOAuthFlowRequest> = {
          code: "test-code",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth/complete",
          body,
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "Missing code or state");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail with invalid state", async () => {
      const ctx = await createTestApp();
      try {
        const body: CompleteOAuthFlowRequest = {
          code: "test-code",
          state: "invalid-state",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth/complete",
          body,
        );
        const error = await assertErrorResponse(response, 400);

        assertExists(error.error);
        assertTrue(error.error.length > 0);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/oauth-token", () => {
    test("should set OAuth token successfully", async () => {
      const ctx = await createTestApp();
      try {
        // Logout first
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        const body: SetOAuthTokenRequest = {
          token: "test-oauth-token-123",
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth-token",
          body,
        );
        const result = await assertSuccessResponse<{ success: boolean }>(
          response,
        );

        assertEquals(result.success, true);

        // Verify auth status updated
        const statusResponse = await request(
          ctx.baseUrl,
          "GET",
          "/api/auth/status",
        );
        const status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.isAuthenticated, true);
        assertEquals(status.authStatus.method, "oauth_token");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail without OAuth token", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/oauth-token",
          {},
        );
        const error = await assertErrorResponse(response, 400);

        assertEquals(error.error, "Missing OAuth token");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/refresh", () => {
    test("should fail when not authenticated with OAuth", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/refresh",
        );
        const error = await assertErrorResponse(response, 400);

        assertExists(error.error);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail when using API key auth", async () => {
      const ctx = await createTestApp();
      try {
        // Already authenticated with API key in test setup

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/auth/refresh",
        );
        const error = await assertErrorResponse(response, 400);

        assertExists(error.error);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/auth/logout", () => {
    test("should logout successfully", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "POST", "/api/auth/logout");
        const result = await assertSuccessResponse<{ success: boolean }>(
          response,
        );

        assertEquals(result.success, true);

        // Verify auth status updated
        const statusResponse = await request(
          ctx.baseUrl,
          "GET",
          "/api/auth/status",
        );
        const status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.isAuthenticated, false);
        assertEquals(status.authStatus.method, "none");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should succeed even when not authenticated", async () => {
      const ctx = await createTestApp();
      try {
        // Logout twice
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        const response = await request(ctx.baseUrl, "POST", "/api/auth/logout");
        const result = await assertSuccessResponse<{ success: boolean }>(
          response,
        );

        assertEquals(result.success, true);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Auth workflow", () => {
    test("should support switching between auth methods", async () => {
      const ctx = await createTestApp();
      try {
        // Start with current auth method (from test setup)
        let statusResponse = await request(
          ctx.baseUrl,
          "GET",
          "/api/auth/status",
        );
        let status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        const initialMethod = status.authStatus.method;

        // Switch to OAuth
        await request(ctx.baseUrl, "POST", "/api/auth/oauth-token", {
          token: "oauth-token",
        });
        statusResponse = await request(ctx.baseUrl, "GET", "/api/auth/status");
        status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.method, "oauth_token");

        // Switch back to API key
        await request(ctx.baseUrl, "POST", "/api/auth/api-key", {
          apiKey: "sk-ant-new-key",
        });
        statusResponse = await request(ctx.baseUrl, "GET", "/api/auth/status");
        status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.method, "api_key");

        // Logout
        await request(ctx.baseUrl, "POST", "/api/auth/logout");
        statusResponse = await request(ctx.baseUrl, "GET", "/api/auth/status");
        status =
          await assertSuccessResponse<GetAuthStatusResponse>(statusResponse);
        assertEquals(status.authStatus.isAuthenticated, false);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
