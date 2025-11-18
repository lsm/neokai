import { Router } from "@oak/oak";
import type { AuthManager } from "../lib/auth-manager.ts";
import type {
  CompleteOAuthFlowRequest,
  GetAuthStatusResponse,
  RefreshTokenResponse,
  SetApiKeyRequest,
  SetOAuthTokenRequest,
  StartOAuthFlowResponse,
} from "@liuboer/shared";

export function createAuthRouter(authManager: AuthManager): Router {
  const router = new Router();

  // Get current authentication status
  router.get("/api/auth/status", async (ctx) => {
    const authStatus = await authManager.getAuthStatus();
    const response: GetAuthStatusResponse = { authStatus };
    ctx.response.body = response;
  });

  // Start OAuth flow
  router.post("/api/auth/oauth/start", async (ctx) => {
    const { authorizationUrl, state } = await authManager.startOAuthFlow();
    const response: StartOAuthFlowResponse = { authorizationUrl, state };
    ctx.response.body = response;
  });

  // Complete OAuth flow (exchange code for token)
  router.post("/api/auth/oauth/complete", async (ctx) => {
    const body = await ctx.request.body.json() as CompleteOAuthFlowRequest;
    const { code, state } = body;

    if (!code || !state) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing code or state" };
      return;
    }

    try {
      await authManager.completeOAuthFlow(code, state);
      const authStatus = await authManager.getAuthStatus();

      ctx.response.body = {
        success: true,
        authStatus,
      };
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        error: error instanceof Error ? error.message : "OAuth flow failed",
      };
    }
  });

  // Set API key
  router.post("/api/auth/api-key", async (ctx) => {
    const body = await ctx.request.body.json() as SetApiKeyRequest;
    const { apiKey } = body;

    if (!apiKey) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing API key" };
      return;
    }

    try {
      await authManager.setApiKey(apiKey);
      ctx.response.status = 200;
      ctx.response.body = { success: true };
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: error instanceof Error ? error.message : "Failed to set API key",
      };
    }
  });

  // Set long-lived OAuth token
  router.post("/api/auth/oauth-token", async (ctx) => {
    const body = await ctx.request.body.json() as SetOAuthTokenRequest;
    const { token } = body;

    if (!token) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing OAuth token" };
      return;
    }

    try {
      await authManager.setOAuthToken(token);
      ctx.response.status = 200;
      ctx.response.body = { success: true };
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: error instanceof Error ? error.message : "Failed to set OAuth token",
      };
    }
  });

  // Refresh OAuth token
  router.post("/api/auth/refresh", async (ctx) => {
    try {
      const expiresAt = await authManager.refreshToken();
      const response: RefreshTokenResponse = {
        success: true,
        expiresAt,
      };
      ctx.response.body = response;
    } catch (error) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        error: error instanceof Error ? error.message : "Failed to refresh token",
      };
    }
  });

  // Logout
  router.post("/api/auth/logout", (ctx) => {
    authManager.logout();
    ctx.response.body = { success: true };
  });

  return router;
}
