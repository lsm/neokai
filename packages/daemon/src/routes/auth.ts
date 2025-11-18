import type { Elysia } from "elysia";
import type { AuthManager } from "../lib/auth-manager";
import type {
  CompleteOAuthFlowRequest,
  GetAuthStatusResponse,
  RefreshTokenResponse,
  SetApiKeyRequest,
  SetOAuthTokenRequest,
  StartOAuthFlowResponse,
} from "@liuboer/shared";

export function createAuthRouter(app: Elysia, authManager: AuthManager) {
  return app
    // Get current authentication status
    .get("/api/auth/status", async () => {
      const authStatus = await authManager.getAuthStatus();
      const response: GetAuthStatusResponse = { authStatus };
      return response;
    })

    // Start OAuth flow
    .post("/api/auth/oauth/start", async () => {
      const { authorizationUrl, state } = await authManager.startOAuthFlow();
      const response: StartOAuthFlowResponse = { authorizationUrl, state };
      return response;
    })

    // Complete OAuth flow (exchange code for token)
    .post("/api/auth/oauth/complete", async ({ body, set }) => {
      const { code, state } = body as CompleteOAuthFlowRequest;

      if (!code || !state) {
        set.status = 400;
        return { error: "Missing code or state" };
      }

      try {
        await authManager.completeOAuthFlow(code, state);
        const authStatus = await authManager.getAuthStatus();

        return {
          success: true,
          authStatus,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          error: error instanceof Error ? error.message : "OAuth flow failed",
        };
      }
    })

    // Set API key
    .post("/api/auth/api-key", async ({ body, set }) => {
      const { apiKey } = body as SetApiKeyRequest;

      if (!apiKey) {
        set.status = 400;
        return { error: "Missing API key" };
      }

      try {
        await authManager.setApiKey(apiKey);
        return { success: true };
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Failed to set API key",
        };
      }
    })

    // Set long-lived OAuth token
    .post("/api/auth/oauth-token", async ({ body, set }) => {
      const { token } = body as SetOAuthTokenRequest;

      if (!token) {
        set.status = 400;
        return { error: "Missing OAuth token" };
      }

      try {
        await authManager.setOAuthToken(token);
        return { success: true };
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Failed to set OAuth token",
        };
      }
    })

    // Refresh OAuth token
    .post("/api/auth/refresh", async ({ set }) => {
      try {
        const expiresAt = await authManager.refreshToken();
        const response: RefreshTokenResponse = {
          success: true,
          expiresAt,
        };
        return response;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to refresh token",
        };
      }
    })

    // Logout
    .post("/api/auth/logout", () => {
      authManager.logout();
      return { success: true };
    });
}
