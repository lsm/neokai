import type { Elysia } from "elysia";
import type { AuthManager } from "../lib/auth-manager";
import type { GetAuthStatusResponse } from "@liuboer/shared";

export function createAuthRouter(app: Elysia, authManager: AuthManager) {
  return app
    // Get current authentication status (read-only)
    .get("/api/auth/status", async () => {
      const authStatus = await authManager.getAuthStatus();
      const response: GetAuthStatusResponse = { authStatus };
      return response;
    });
}
